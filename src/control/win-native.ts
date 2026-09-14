import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DomainError, ErrorCode } from "../types.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";

export interface AppWindowRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisibleAppWindow {
  /** Ephemeral id scoped only to this observation result. Never accepted as authority for later input. */
  windowId: string;
  processId: number;
  processName: string;
  appName: string;
  title: string;
  visible: true;
  minimized: boolean;
  foreground: boolean;
  bounds: AppWindowRegion;
}

interface HelperWindow {
  processId?: number;
  processName?: string;
  appName?: string;
  title?: string;
  visible?: boolean;
  minimized?: boolean;
  foreground?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface HelperRequest {
  id: number;
  op: "frontmost" | "listWindows" | "windowRect" | "click" | "type" | "key";
  appName?: string;
  x?: number;
  y?: number;
  text?: string;
  virtualKey?: number;
}

interface HelperResponse {
  id: number;
  ok: boolean;
  ready?: boolean;
  error?: string;
  appName?: string;
  windows?: HelperWindow[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface PendingRequest {
  resolve: (value: HelperResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_STDERR = 8_000;
const MAX_VISIBLE_WINDOWS = 200;

/** Preserve the existing macOS CG keyCode wire contract and translate it at
 * the Windows boundary instead of silently reinterpreting the integer as a
 * Win32 VK code. */
const MAC_KEYCODE_TO_WINDOWS_VK: Readonly<Record<number, number>> = {
  0: 0x41, 1: 0x53, 2: 0x44, 3: 0x46, 4: 0x48, 5: 0x47,
  6: 0x5a, 7: 0x58, 8: 0x43, 9: 0x56, 11: 0x42,
  12: 0x51, 13: 0x57, 14: 0x45, 15: 0x52, 16: 0x59, 17: 0x54,
  18: 0x31, 19: 0x32, 20: 0x33, 21: 0x34, 22: 0x36, 23: 0x35,
  24: 0xbb, 25: 0x39, 26: 0x37, 27: 0xbd, 28: 0x38, 29: 0x30,
  30: 0xdd, 31: 0x4f, 32: 0x55, 33: 0xdb, 34: 0x49, 35: 0x50,
  36: 0x0d, 37: 0x4c, 38: 0x4a, 39: 0xde, 40: 0x4b, 41: 0xba,
  42: 0xdc, 43: 0xbc, 44: 0xbf, 45: 0x4e, 46: 0x4d, 47: 0xbe,
  48: 0x09, 49: 0x20, 50: 0xc0, 51: 0x08, 53: 0x1b,
  55: 0x5b, 56: 0x10, 57: 0x14, 58: 0x12, 59: 0x11,
  60: 0xa1, 61: 0xa5, 62: 0xa3,
  65: 0x6e, 67: 0x6a, 69: 0x6b, 71: 0x0c, 75: 0x6f, 76: 0x0d,
  78: 0x6d, 81: 0x6c,
  82: 0x60, 83: 0x61, 84: 0x62, 85: 0x63, 86: 0x64,
  87: 0x65, 88: 0x66, 89: 0x67, 91: 0x68, 92: 0x69,
  96: 0x74, 97: 0x75, 98: 0x76, 99: 0x72, 100: 0x77, 101: 0x78,
  103: 0x7a, 105: 0x7c, 107: 0x7d, 109: 0x79, 111: 0x7b,
  114: 0x2d, 115: 0x24, 116: 0x21, 117: 0x2e, 118: 0x73,
  119: 0x23, 120: 0x71, 121: 0x22, 122: 0x70,
  123: 0x25, 124: 0x27, 125: 0x28, 126: 0x26,
};

export function windowsVirtualKeyForLegacyKeyCode(keyCode: number): number | undefined {
  if (!Number.isInteger(keyCode)) return undefined;
  return MAC_KEYCODE_TO_WINDOWS_VK[keyCode];
}

export function supportsLegacyKeyCodeOnWindows(keyCode: number): boolean {
  return windowsVirtualKeyForLegacyKeyCode(keyCode) !== undefined;
}

const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ChatGpt2CodexWinInput {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
    }
    public sealed class WindowInfo {
        public uint processId { get; set; }
        public string processName { get; set; }
        public string appName { get; set; }
        public string title { get; set; }
        public bool visible { get; set; }
        public bool minimized { get; set; }
        public bool foreground { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const int SW_RESTORE = 9;
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    static Process WindowProcess(IntPtr hWnd) {
        uint pid; GetWindowThreadProcessId(hWnd, out pid);
        if (pid == 0) return null;
        try { return Process.GetProcessById((int)pid); } catch { return null; }
    }
    static string ProcessName(Process process) {
        if (process == null) return null;
        try { return process.ProcessName; } catch { return null; }
    }
    static string Description(Process process) {
        if (process == null) return null;
        try {
            var description = process.MainModule.FileVersionInfo.FileDescription;
            if (!String.IsNullOrWhiteSpace(description)) return description.Trim();
            var product = process.MainModule.FileVersionInfo.ProductName;
            if (!String.IsNullOrWhiteSpace(product)) return product.Trim();
        } catch { }
        return ProcessName(process);
    }
    static string WindowTitle(IntPtr hWnd) {
        var length = GetWindowTextLength(hWnd);
        if (length <= 0) return null;
        var buffer = new StringBuilder(length + 1);
        if (GetWindowText(hWnd, buffer, buffer.Capacity) <= 0) return null;
        var title = buffer.ToString().Trim();
        return String.IsNullOrWhiteSpace(title) ? null : title;
    }
    static bool Match(Process process, string requested) {
        if (process == null || String.IsNullOrWhiteSpace(requested)) return false;
        var needle = requested.Trim();
        if (needle.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) needle = needle.Substring(0, needle.Length - 4);
        if (String.Equals(ProcessName(process), needle, StringComparison.OrdinalIgnoreCase)) return true;
        var description = Description(process);
        return !String.IsNullOrWhiteSpace(description) && String.Equals(description, requested.Trim(), StringComparison.OrdinalIgnoreCase);
    }
    public static string ForegroundAppName() { return Description(WindowProcess(GetForegroundWindow())); }
    public static WindowInfo[] ListVisibleWindows(int maxCount) {
        var results = new List<WindowInfo>();
        var foreground = GetForegroundWindow();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (results.Count >= maxCount) return false;
            if (!IsWindowVisible(hWnd)) return true;
            var title = WindowTitle(hWnd);
            if (String.IsNullOrWhiteSpace(title)) return true;
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            var width = rect.Right - rect.Left;
            var height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var process = WindowProcess(hWnd);
            var processName = ProcessName(process);
            if (process == null || String.IsNullOrWhiteSpace(processName)) return true;
            results.Add(new WindowInfo {
                processId = pid,
                processName = processName,
                appName = Description(process) ?? processName,
                title = title,
                visible = true,
                minimized = IsIconic(hWnd),
                foreground = hWnd == foreground,
                x = rect.Left,
                y = rect.Top,
                width = width,
                height = height
            });
            return true;
        }, IntPtr.Zero);
        return results.ToArray();
    }
    public static IntPtr FindWindow(string appName) {
        var foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero && IsWindowVisible(foreground) && Match(WindowProcess(foreground), appName)) return foreground;
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            if (Match(WindowProcess(hWnd), appName)) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static IntPtr Activate(string appName) {
        var hWnd = FindWindow(appName);
        if (hWnd == IntPtr.Zero) throw new InvalidOperationException("target app window not found");
        if (GetForegroundWindow() == hWnd) return hWnd;
        ShowWindowAsync(hWnd, SW_RESTORE);
        if (!SetForegroundWindow(hWnd)) throw new InvalidOperationException("Windows refused to activate the target app window");
        Thread.Sleep(75);
        if (GetForegroundWindow() != hWnd) throw new InvalidOperationException("target app did not become foreground; synthetic input refused");
        return hWnd;
    }
    public static RECT RectForApp(string appName) {
        var hWnd = Activate(appName); RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new InvalidOperationException("could not read target app window bounds");
        return rect;
    }
    public static void Click(string appName, int x, int y) {
        Activate(appName);
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("could not move pointer");
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_MOUSE; inputs[0].U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        inputs[1].type = INPUT_MOUSE; inputs[1].U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput mouse click failed");
    }
    public static void TypeUnicode(string appName, string text) {
        Activate(appName); if (String.IsNullOrEmpty(text)) return;
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (char ch in text) {
            var down = new INPUT(); down.type = INPUT_KEYBOARD; down.U.ki.wScan = ch; down.U.ki.dwFlags = KEYEVENTF_UNICODE; inputs.Add(down);
            var up = down; up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP; inputs.Add(up);
        }
        var array = inputs.ToArray();
        if (SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT))) != array.Length) throw new InvalidOperationException("SendInput Unicode text failed");
    }
    public static void PressKey(string appName, ushort virtualKey) {
        Activate(appName);
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD; inputs[0].U.ki.wVk = virtualKey;
        inputs[1] = inputs[0]; inputs[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput key failed");
    }
}
'@

[Console]::Out.WriteLine((@{ id=0; ok=$true; ready=$true } | ConvertTo-Json -Compress))
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $payload = $line | ConvertFrom-Json
    $id = [int]$payload.id
    switch ([string]$payload.op) {
      'frontmost' { $result = @{ id=$id; ok=$true; appName=[ChatGpt2CodexWinInput]::ForegroundAppName() } }
      'listWindows' { $result = @{ id=$id; ok=$true; windows=@([ChatGpt2CodexWinInput]::ListVisibleWindows(200)) } }
      'windowRect' {
        $r = [ChatGpt2CodexWinInput]::RectForApp([string]$payload.appName)
        $result = @{ id=$id; ok=$true; x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top) }
      }
      'click' { [ChatGpt2CodexWinInput]::Click([string]$payload.appName,[int]$payload.x,[int]$payload.y); $result=@{id=$id;ok=$true} }
      'type' { [ChatGpt2CodexWinInput]::TypeUnicode([string]$payload.appName,[string]$payload.text); $result=@{id=$id;ok=$true} }
      'key' { [ChatGpt2CodexWinInput]::PressKey([string]$payload.appName,[uint16]$payload.virtualKey); $result=@{id=$id;ok=$true} }
      default { throw 'unsupported Windows input operation' }
    }
  } catch {
    $result = @{ id=$id; ok=$false; error=$_.Exception.Message }
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
`;

let helper: ChildProcessWithoutNullStreams | undefined;
let helperStart: Promise<ChildProcessWithoutNullStreams> | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();
let stderrTail = "";

function assertWin32(): void {
  if (process.platform !== "win32") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Windows desktop input is only supported on Windows");
  }
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function helperScriptPath(): Promise<string> {
  const digest = createHash("sha256").update(WINDOWS_HELPER_SCRIPT).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "chatgpt2codex");
  const file = path.join(dir, `win-input-${digest}.ps1`);
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readFile(file, "utf8").catch(() => undefined);
  if (existing !== WINDOWS_HELPER_SCRIPT) await fs.writeFile(file, WINDOWS_HELPER_SCRIPT, "utf8");
  return file;
}

function failPending(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function unrefHelperHandles(child: ChildProcessWithoutNullStreams): void {
  child.unref();
  (child.stdin as unknown as { unref?: () => void }).unref?.();
  (child.stdout as unknown as { unref?: () => void }).unref?.();
  (child.stderr as unknown as { unref?: () => void }).unref?.();
}

async function startHelper(): Promise<ChildProcessWithoutNullStreams> {
  assertWin32();
  if (helper && !helper.killed && helper.exitCode === null) return helper;
  if (helperStart) return helperStart;
  helperStart = (async () => {
    const script = await helperScriptPath();
    const child = spawn(
      powershellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
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
      const error = new Error(
        `Windows desktop helper startup timed out: ${stderrTail.trim() || "no stderr"}`,
      );
      rejectReady(error);
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
      if (!Number.isInteger(response.id)) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response);
      else request.reject(new Error(response.error || "Windows desktop helper failed"));
    });
    child.once("error", (error) => {
      if (helper === child) helper = undefined;
      settleReadyFailure(error);
      failPending(error);
    });
    child.once("exit", (code) => {
      if (helper === child) helper = undefined;
      const error = new Error(`Windows desktop helper exited ${code ?? "unknown"}: ${stderrTail.trim() || "no stderr"}`);
      settleReadyFailure(error);
      failPending(error);
    });
    helper = child;
    unrefHelperHandles(child);

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

async function requestHelper(payload: Omit<HelperRequest, "id">): Promise<HelperResponse> {
  const child = await startHelper();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error(`Windows desktop input helper request timed out (${payload.op})`);
      reject(error);
      if (helper === child) helper = undefined;
      if (child.exitCode === null && !child.killed) child.kill();
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      reject(error);
    });
  });
}

function normalizeVisibleWindow(window: HelperWindow, index: number): VisibleAppWindow | undefined {
  const processId = window.processId;
  const processName = window.processName?.trim();
  const appName = window.appName?.trim() || processName;
  const title = window.title?.trim();
  const x = window.x;
  const y = window.y;
  const width = window.width;
  const height = window.height;
  if (!Number.isInteger(processId) || (processId as number) <= 0 || !processName || !appName || !title) return undefined;
  if (![x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  if ((width as number) <= 0 || (height as number) <= 0) return undefined;
  return {
    windowId: `window-${index + 1}`,
    processId: processId as number,
    processName,
    appName,
    title,
    visible: true,
    minimized: window.minimized === true,
    foreground: window.foreground === true,
    bounds: {
      x: Math.round(x as number),
      y: Math.round(y as number),
      width: Math.round(width as number),
      height: Math.round(height as number),
    },
  };
}

export async function resolveFrontmostApp(): Promise<string | undefined> {
  const result = await requestHelper({ op: "frontmost" });
  const name = result.appName?.trim();
  return name || undefined;
}

/**
 * Read-only top-level window observation. No HWND values leave the helper:
 * callers receive observation-scoped ids that are deliberately useless as
 * later authorization. Every real action still re-resolves the app/window
 * immediately before emitting input.
 */
export async function listVisibleWindows(): Promise<VisibleAppWindow[]> {
  const result = await requestHelper({ op: "listWindows" });
  const rows = Array.isArray(result.windows) ? result.windows.slice(0, MAX_VISIBLE_WINDOWS) : [];
  return rows
    .map((window, index) => normalizeVisibleWindow(window, index))
    .filter((window): window is VisibleAppWindow => window !== undefined);
}

export async function getAppWindowRegion(appName: string): Promise<AppWindowRegion> {
  const result = await requestHelper({ op: "windowRect", appName });
  const values = [result.x, result.y, result.width, result.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Windows desktop helper returned invalid window bounds");
  }
  return {
    x: Math.round(result.x as number),
    y: Math.round(result.y as number),
    width: Math.round(result.width as number),
    height: Math.round(result.height as number),
  };
}

export async function resolveWindowPoint(appName: string, xRel: number, yRel: number): Promise<{ x: number; y: number }> {
  const region = await getAppWindowRegion(appName);
  return { x: Math.round(region.x + region.width * xRel), y: Math.round(region.y + region.height * yRel) };
}

export async function clickAtPoint(appName: string, x: number, y: number): Promise<void> {
  await requestHelper({ op: "click", appName, x: Math.round(x), y: Math.round(y) });
}

export async function typeText(appName: string, text: string): Promise<void> {
  await requestHelper({ op: "type", appName, text });
}

export async function pressKey(appName: string, keyCode: number): Promise<void> {
  const virtualKey = windowsVirtualKeyForLegacyKeyCode(keyCode);
  if (virtualKey === undefined) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Legacy keyCode ${keyCode} does not have a Windows mapping yet`);
  }
  await requestHelper({ op: "key", appName, virtualKey });
}

/** Tests and shutdown paths may call this without injecting input. */
export async function stopWindowsInputHelper(): Promise<void> {
  const child = helper;
  helper = undefined;
  if (!child || child.exitCode !== null) return;
  child.stdin.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
