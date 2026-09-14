import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { buildSafeChildEnv } from "../exec/command-runner.js";

interface ActivityDriver {
  show(): Promise<void>;
  hide(): Promise<void>;
}

interface HelperRequest {
  id: number;
  op: "show" | "hide" | "status" | "shutdown";
}

interface HelperResponse {
  id: number;
  ok: boolean;
  ready?: boolean;
  visible?: boolean;
  error?: string;
}

interface PendingRequest {
  resolve: (value: HelperResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_HIDE_MS = 900;
const MAX_STDERR = 6_000;

/**
 * A dedicated persistent helper owns the visual overlay. Keeping it separate
 * from win-native.ts is intentional: a cosmetic indicator can fail/restart
 * without disturbing the trusted SendInput helper or changing authorization.
 *
 * The overlay consists of thin topmost strips around every Windows display
 * plus a small "Computer Use" badge on the primary display. Every window is
 * TOOLWINDOW + NOACTIVATE + TRANSPARENT, returns HTTRANSPARENT for hit-tests,
 * and requests WDA_EXCLUDEFROMCAPTURE. capture.ts additionally suppresses the
 * overlay around the actual pixel read as a fallback for capture APIs/drivers
 * that ignore display affinity.
 */
const WINDOWS_ACTIVITY_SCRIPT = String.raw`
param(
  [switch]$Probe,
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$formsAssembly = [System.Windows.Forms.Form].Assembly.Location
$drawingAssembly = [System.Drawing.Color].Assembly.Location
Add-Type -ReferencedAssemblies @($formsAssembly, $drawingAssembly) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public sealed class ComputerUseOverlayForm : Form {
    const int WS_EX_TRANSPARENT = 0x20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int WM_NCHITTEST = 0x0084;
    const int WM_MOUSEACTIVATE = 0x0021;
    static readonly IntPtr HTTRANSPARENT = new IntPtr(-1);
    static readonly IntPtr MA_NOACTIVATE = new IntPtr(3);
    const uint WDA_EXCLUDEFROMCAPTURE = 0x11;

    [DllImport("user32.dll")]
    static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    public ComputerUseOverlayForm(Rectangle bounds, Color color, double opacity) {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = color;
        Opacity = opacity;
        Bounds = bounds;
        TabStop = false;
        Enabled = false;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        try { SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE); } catch { }
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_NCHITTEST) { m.Result = HTTRANSPARENT; return; }
        if (m.Msg == WM_MOUSEACTIVATE) { m.Result = MA_NOACTIVATE; return; }
        base.WndProc(ref m);
    }
}

public static class ComputerUseOverlayHost {
    static readonly object Sync = new object();
    static Thread uiThread;
    static Control dispatcher;
    static ManualResetEventSlim ready;
    static List<Form> forms = new List<Form>();
    static bool visible;
    static int parentPid;

    public static int Probe() {
        return Screen.AllScreens.Length;
    }

    public static void EnsureStarted(int ownerPid) {
        lock (Sync) {
            if (uiThread != null && uiThread.IsAlive && dispatcher != null && !dispatcher.IsDisposed) return;
            parentPid = ownerPid;
            ready = new ManualResetEventSlim(false);
            uiThread = new Thread(UiMain);
            uiThread.IsBackground = true;
            uiThread.Name = "chatgpt2codex-computer-use-indicator";
            uiThread.SetApartmentState(ApartmentState.STA);
            uiThread.Start();
        }
        if (!ready.Wait(5000)) throw new InvalidOperationException("activity indicator UI thread did not start");
    }

    static void UiMain() {
        dispatcher = new Control();
        dispatcher.CreateControl();

        var parentTimer = new System.Windows.Forms.Timer();
        parentTimer.Interval = 2000;
        parentTimer.Tick += delegate {
            if (parentPid <= 0) return;
            try {
                var p = Process.GetProcessById(parentPid);
                if (p.HasExited) throw new InvalidOperationException();
            } catch {
                HideCore();
                Application.ExitThread();
            }
        };
        parentTimer.Start();
        ready.Set();
        Application.Run();
        parentTimer.Stop();
        parentTimer.Dispose();
        HideCore();
        dispatcher.Dispose();
        dispatcher = null;
        visible = false;
    }

    static Rectangle ClampRect(Rectangle r) {
        return new Rectangle(r.X, r.Y, Math.Max(1, r.Width), Math.Max(1, r.Height));
    }

    static void AddStrip(Rectangle bounds, Color color, double opacity) {
        var form = new ComputerUseOverlayForm(ClampRect(bounds), color, opacity);
        forms.Add(form);
        form.Show();
    }

    static void ShowCore() {
        if (visible) return;
        HideCore();
        var accent = Color.FromArgb(0, 120, 212);
        const int thickness = 3;
        foreach (var screen in Screen.AllScreens) {
            var b = screen.Bounds;
            AddStrip(new Rectangle(b.Left, b.Top, b.Width, thickness), accent, 0.58);
            AddStrip(new Rectangle(b.Left, b.Bottom - thickness, b.Width, thickness), accent, 0.58);
            AddStrip(new Rectangle(b.Left, b.Top, thickness, b.Height), accent, 0.58);
            AddStrip(new Rectangle(b.Right - thickness, b.Top, thickness, b.Height), accent, 0.58);
        }

        var primary = Screen.PrimaryScreen;
        if (primary != null) {
            var b = primary.Bounds;
            const int badgeWidth = 126;
            const int badgeHeight = 26;
            var badge = new ComputerUseOverlayForm(
                new Rectangle(b.Left + (b.Width - badgeWidth) / 2, b.Top + 8, badgeWidth, badgeHeight),
                Color.FromArgb(32, 32, 32),
                0.86
            );
            var label = new Label();
            label.Text = "Computer Use";
            label.ForeColor = Color.White;
            label.BackColor = Color.Transparent;
            label.Dock = DockStyle.Fill;
            label.TextAlign = ContentAlignment.MiddleCenter;
            label.Font = new Font("Segoe UI", 9.0f, FontStyle.Bold);
            label.Enabled = false;
            badge.Controls.Add(label);
            forms.Add(badge);
            badge.Show();
        }
        visible = true;
    }

    static void HideCore() {
        foreach (var form in forms) {
            try { form.Hide(); form.Close(); form.Dispose(); } catch { }
        }
        forms.Clear();
        visible = false;
    }

    static void Invoke(Action action) {
        var target = dispatcher;
        if (target == null || target.IsDisposed) throw new InvalidOperationException("activity indicator dispatcher is unavailable");
        target.Invoke(action);
    }

    public static void Show(int ownerPid) {
        EnsureStarted(ownerPid);
        Invoke(ShowCore);
    }

    public static void Hide() {
        var target = dispatcher;
        if (target == null || target.IsDisposed) return;
        Invoke(HideCore);
    }

    public static bool IsVisible() {
        var target = dispatcher;
        if (target == null || target.IsDisposed) return false;
        object result = target.Invoke(new Func<bool>(delegate { return visible; }));
        return result is bool && (bool)result;
    }

    public static void Shutdown() {
        var target = dispatcher;
        if (target == null || target.IsDisposed) return;
        try {
            target.Invoke(new Action(delegate {
                HideCore();
                Application.ExitThread();
            }));
        } catch { }
    }
}
'@

if ($Probe) {
  [Console]::Out.WriteLine((@{ ok=$true; screens=[ComputerUseOverlayHost]::Probe() } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  exit 0
}

[ComputerUseOverlayHost]::EnsureStarted($ParentPid)
[Console]::Out.WriteLine((@{ id=0; ok=$true; ready=$true } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
$done = $false
while (-not $done -and ($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $payload = $line | ConvertFrom-Json
    $id = [int]$payload.id
    switch ([string]$payload.op) {
      'show' { [ComputerUseOverlayHost]::Show($ParentPid); $result = @{ id=$id; ok=$true; visible=$true } }
      'hide' { [ComputerUseOverlayHost]::Hide(); $result = @{ id=$id; ok=$true; visible=$false } }
      'status' { $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }
      'shutdown' {
        [ComputerUseOverlayHost]::Shutdown()
        $result = @{ id=$id; ok=$true; visible=$false }
        $done = $true
      }
      default { throw 'unsupported activity indicator operation' }
    }
  } catch {
    $result = @{ id=$id; ok=$false; error=$_.Exception.Message }
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
[ComputerUseOverlayHost]::Shutdown()
`;

let helper: ChildProcessWithoutNullStreams | undefined;
let helperStart: Promise<ChildProcessWithoutNullStreams> | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();
let stderrTail = "";

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function helperScriptPath(): Promise<string> {
  const digest = createHash("sha256").update(WINDOWS_ACTIVITY_SCRIPT).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "chatgpt2codex");
  const file = path.join(dir, `computer-use-indicator-${digest}.ps1`);
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readFile(file, "utf8").catch(() => undefined);
  if (existing !== WINDOWS_ACTIVITY_SCRIPT) await fs.writeFile(file, WINDOWS_ACTIVITY_SCRIPT, "utf8");
  return file;
}

function failPending(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

async function startHelper(): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform !== "win32") throw new Error("Windows activity indicator is only supported on Windows");
  if (helper && !helper.killed && helper.exitCode === null) return helper;
  if (helperStart) return helperStart;

  helperStart = (async () => {
    const script = await helperScriptPath();
    const child = spawn(
      powershellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ParentPid", String(process.pid)],
      { env: buildSafeChildEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    stderrTail = "";
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-MAX_STDERR);
    });

    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const readyTimer = setTimeout(() => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(new Error(`Computer Use indicator startup timed out: ${stderrTail.trim() || "no stderr"}`));
      child.kill();
    }, STARTUP_TIMEOUT_MS);

    const settleReadyFailure = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(error);
    };

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let response: HelperResponse;
      try { response = JSON.parse(line) as HelperResponse; } catch { return; }
      if (response.id === 0 && response.ok && response.ready) {
        if (!readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          resolveReady();
        }
        return;
      }
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response);
      else request.reject(new Error(response.error || "Computer Use activity indicator helper failed"));
    });

    child.once("error", (error) => {
      if (helper === child) helper = undefined;
      settleReadyFailure(error);
      failPending(error);
    });
    child.once("exit", (code) => {
      if (helper === child) helper = undefined;
      const error = new Error(`Computer Use activity indicator helper exited ${code ?? "unknown"}: ${stderrTail.trim() || "no stderr"}`);
      settleReadyFailure(error);
      failPending(error);
    });
    helper = child;

    try {
      await readyPromise;
      return child;
    } catch (error) {
      if (helper === child) helper = undefined;
      if (child.exitCode === null && !child.killed) child.kill();
      throw error;
    }
  })();

  try {
    return await helperStart;
  } finally {
    helperStart = undefined;
  }
}

async function requestHelper(op: HelperRequest["op"]): Promise<HelperResponse> {
  const child = await startHelper();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Computer Use activity indicator request timed out (${op})`));
      if (helper === child) helper = undefined;
      if (child.exitCode === null && !child.killed) child.kill();
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, op })}\n`, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      reject(error);
    });
  });
}

const nativeDriver: ActivityDriver = {
  async show() {
    if (process.platform !== "win32") return;
    await requestHelper("show");
  },
  async hide() {
    if (process.platform !== "win32") return;
    if (!helper || helper.exitCode !== null || helper.killed) return;
    await requestHelper("hide");
  },
};

let testDriver: ActivityDriver | undefined;
let activeCount = 0;
let suppressCount = 0;
let visible = false;
let hideTimer: NodeJS.Timeout | undefined;
let transition: Promise<void> = Promise.resolve();
let idleHideMs = DEFAULT_IDLE_HIDE_MS;

function enabled(): boolean {
  return testDriver !== undefined || process.platform === "win32";
}

function driver(): ActivityDriver {
  return testDriver ?? nativeDriver;
}

function cancelHideTimer(): void {
  if (!hideTimer) return;
  clearTimeout(hideTimer);
  hideTimer = undefined;
}

function queueTransition(fn: () => Promise<void>): Promise<void> {
  const next = transition.then(fn, fn);
  transition = next.catch(() => undefined);
  return next;
}

async function setVisible(nextVisible: boolean): Promise<void> {
  if (!enabled() || visible === nextVisible) return;
  try {
    if (nextVisible) await driver().show();
    else await driver().hide();
    visible = nextVisible;
  } catch {
    // The indicator is intentionally cosmetic. Never make Computer Use fail
    // because the overlay process, Windows desktop, or capture exclusion is
    // unavailable.
    if (!nextVisible) visible = false;
  }
}

function shouldBeVisible(): boolean {
  return activeCount > 0 && suppressCount === 0;
}

async function syncVisibility(): Promise<void> {
  await setVisible(shouldBeVisible());
}

/** Start one Computer Use activity scope. The returned release function is
 * idempotent. Multiple overlapping scopes share one overlay and a short idle
 * debounce prevents flicker between screenshot/action sub-steps. */
export async function beginComputerUseActivity(): Promise<() => Promise<void>> {
  if (!enabled()) return async () => undefined;
  cancelHideTimer();
  activeCount += 1;
  await queueTransition(syncVisibility);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount > 0) {
      await queueTransition(syncVisibility);
      return;
    }
    cancelHideTimer();
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      void queueTransition(syncVisibility);
    }, idleHideMs);
    hideTimer.unref?.();
  };
}

export async function withComputerUseActivity<T>(fn: () => Promise<T>): Promise<T> {
  const release = await beginComputerUseActivity();
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Temporarily hide the overlay while pixels are being captured. This is a
 * defense-in-depth fallback for screen-copy paths that do not honor
 * WDA_EXCLUDEFROMCAPTURE. The activity scope itself remains active and is
 * restored immediately after capture. */
export async function withComputerUseIndicatorSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  cancelHideTimer();
  suppressCount += 1;
  await queueTransition(syncVisibility);
  try {
    return await fn();
  } finally {
    suppressCount = Math.max(0, suppressCount - 1);
    await queueTransition(syncVisibility);
  }
}

/** Kill/cancel path: indicator state is not authorization, but it should
 * disappear immediately when control is killed. Any late release from an
 * already-running scope is harmless because the count is clamped at zero. */
export async function forceHideComputerUseActivity(): Promise<void> {
  cancelHideTimer();
  activeCount = 0;
  suppressCount = 0;
  await queueTransition(async () => setVisible(false));
}

/** Compile-only native smoke probe. It never creates or shows overlay
 * windows, making it safe for hosted Windows CI. */
export async function probeWindowsActivityIndicatorSupport(): Promise<{ ok: boolean; screens: number }> {
  if (process.platform !== "win32") return { ok: false, screens: 0 };
  const script = await helperScriptPath();
  const child = spawn(
    powershellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Probe"],
    { env: buildSafeChildEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Computer Use indicator probe exited ${code}: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; screens?: number };
  return { ok: parsed.ok === true, screens: Number.isFinite(parsed.screens) ? Number(parsed.screens) : 0 };
}

/** Tests/shutdown may stop the persistent cosmetic helper explicitly. */
export async function stopWindowsActivityIndicatorHelper(): Promise<void> {
  cancelHideTimer();
  activeCount = 0;
  suppressCount = 0;
  visible = false;
  const child = helper;
  if (!child || child.exitCode !== null || child.killed) {
    helper = undefined;
    return;
  }
  try {
    await requestHelper("shutdown");
  } catch {
    // fall through to process termination
  }
  helper = undefined;
  if (child.exitCode === null && !child.killed) child.kill();
}

export function __setComputerUseActivityDriverForTests(next: ActivityDriver | undefined, options: { idleHideMs?: number } = {}): void {
  cancelHideTimer();
  testDriver = next;
  activeCount = 0;
  suppressCount = 0;
  visible = false;
  transition = Promise.resolve();
  idleHideMs = options.idleHideMs ?? DEFAULT_IDLE_HIDE_MS;
}

export function __getComputerUseActivityStateForTests(): { activeCount: number; suppressCount: number; visible: boolean } {
  return { activeCount, suppressCount, visible };
}
