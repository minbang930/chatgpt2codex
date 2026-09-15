import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import { signalComputerUseCancel } from "./cancel.js";

interface ActivityDriver {
  show(): Promise<void>;
  hide(): Promise<void>;
}

interface HelperRequest {
  id: number;
  op: "show" | "hide" | "status" | "armCancel" | "disarmCancel" | "pulse" | "pointer" | "shutdown";
  x?: number;
  y?: number;
  durationMs?: number;
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

const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_HIDE_MS = 1_200;
const MAX_STDERR = 6_000;

/**
 * A dedicated persistent helper owns the visual overlay. Keeping it separate
 * from win-native.ts is intentional: a cosmetic indicator can fail/restart
 * without disturbing the trusted SendInput helper or changing authorization.
 *
 * The overlay uses translucent topmost glow bands plus one shaped interaction
 * overlay per Windows display. Glow intensity breathes while geometry stays
 * fixed; the primary-display badge remains intentionally static. Every window is
 * TOOLWINDOW + NOACTIVATE + TRANSPARENT, returns HTTRANSPARENT for hit-tests,
 * and requests WDA_EXCLUDEFROMCAPTURE. capture.ts additionally suppresses the
 * overlay around the actual pixel read as a fallback for capture APIs/drivers
 * that ignore display affinity.
 */
const WINDOWS_ACTIVITY_SCRIPT = String.raw`
param(
  [switch]$Probe,
  [int]$ParentPid = 0,
  [string]$CancelFile = ''
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
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public sealed class ComputerUseGlowBandForm : Form {
    const int WS_EX_TRANSPARENT = 0x20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int WM_NCHITTEST = 0x0084;
    const int WM_MOUSEACTIVATE = 0x0021;
    static readonly IntPtr HTTRANSPARENT = new IntPtr(-1);
    static readonly IntPtr MA_NOACTIVATE = new IntPtr(3);
    const uint WDA_EXCLUDEFROMCAPTURE = 0x11;

    readonly double baseOpacity;

    [DllImport("user32.dll")]
    static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    public ComputerUseGlowBandForm(Rectangle bounds, double opacity) {
        baseOpacity = Math.Max(0.01, Math.Min(0.80, opacity));
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Color.FromArgb(0, 126, 230);
        Opacity = baseOpacity;
        Bounds = bounds;
        TabStop = false;
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

    public void SetPulse(double pulse) {
        // Glow breathes through luminance/opacity only. Geometry never changes,
        // avoiding the hard expanding-border look of the previous indicator.
        double multiplier = 0.88 + (0.18 * Math.Max(0.0, Math.Min(1.0, pulse)));
        Opacity = Math.Max(0.01, Math.Min(0.82, baseOpacity * multiplier));
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_NCHITTEST) { m.Result = HTTRANSPARENT; return; }
        if (m.Msg == WM_MOUSEACTIVATE) { m.Result = MA_NOACTIVATE; return; }
        base.WndProc(ref m);
    }
}

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

    readonly bool showBadge;
    readonly System.Windows.Forms.Timer animationTimer;
    int dpi = 96;
    bool rippleActive;
    Point ripplePoint;
    long rippleStartedAt;
    long pointerVisibleUntil;
    const double ActivityPeriodSeconds = 1.6;
    const double RippleDurationSeconds = 0.62;

    [DllImport("user32.dll")]
    static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    public static void EnableProcessDpiAwareness() {
        try {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    public ComputerUseOverlayForm(Rectangle bounds, bool showPrimaryBadge) {
        showBadge = showPrimaryBadge;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Color.Black;
        Opacity = 0.90;
        Bounds = bounds;
        TabStop = false;
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        animationTimer = new System.Windows.Forms.Timer();
        animationTimer.Interval = 33;
        animationTimer.Tick += delegate {
            if (rippleActive && RippleProgress() >= 1.0) rippleActive = false;
            UpdateWindowRegion();
            Invalidate();
        };
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    int Scale(int logicalPixels) {
        return Math.Max(1, (int)Math.Round(logicalPixels * Math.Max(96, dpi) / 96.0));
    }

    double ActivityPulse() {
        double seconds = (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency;
        return (Math.Sin((seconds / ActivityPeriodSeconds) * Math.PI * 2.0) + 1.0) / 2.0;
    }

    int CurrentBorderThickness() {
        int min = Scale(4);
        int delta = Scale(2);
        return min + (int)Math.Round(ActivityPulse() * delta);
    }

    Rectangle[] BorderRects(int thickness) {
        int inset = Scale(2);
        int width = Math.Max(1, ClientSize.Width);
        int height = Math.Max(1, ClientSize.Height);
        int horizontalWidth = Math.Max(1, width - (2 * inset));
        int verticalHeight = Math.Max(1, height - (2 * inset));
        return new Rectangle[] {
            new Rectangle(inset, inset, horizontalWidth, thickness),
            new Rectangle(inset, Math.Max(inset, height - inset - thickness), horizontalWidth, thickness),
            new Rectangle(inset, inset, thickness, verticalHeight),
            new Rectangle(Math.Max(inset, width - inset - thickness), inset, thickness, verticalHeight),
        };
    }

    double RippleProgress() {
        if (!rippleActive) return 1.0;
        double elapsed = (double)(Stopwatch.GetTimestamp() - rippleStartedAt) / Stopwatch.Frequency;
        return Math.Max(0.0, Math.Min(1.0, elapsed / RippleDurationSeconds));
    }

    Rectangle RippleRect(double progress) {
        int startRadius = Scale(7);
        int travel = Scale(25);
        int radius = startRadius + (int)Math.Round(travel * progress);
        return new Rectangle(ripplePoint.X - radius, ripplePoint.Y - radius, radius * 2, radius * 2);
    }

    Region RippleRingRegion() {
        double progress = RippleProgress();
        var outerRect = RippleRect(progress);
        var outerPath = new GraphicsPath();
        outerPath.AddEllipse(outerRect);
        var ring = new Region(outerPath);
        outerPath.Dispose();
        int ringWidth = Scale(5);
        var innerRect = Rectangle.Inflate(outerRect, -ringWidth, -ringWidth);
        if (innerRect.Width > 1 && innerRect.Height > 1) {
            using (var innerPath = new GraphicsPath()) {
                innerPath.AddEllipse(innerRect);
                ring.Exclude(innerPath);
            }
        }
        return ring;
    }

    public void PulseAtScreen(int x, int y) {
        if (!Bounds.Contains(x, y)) return;
        ripplePoint = new Point(x - Bounds.Left, y - Bounds.Top);
        rippleStartedAt = Stopwatch.GetTimestamp();
        rippleActive = true;
        UpdateWindowRegion();
        Invalidate();
    }

    bool PointerActive() {
        return Stopwatch.GetTimestamp() < pointerVisibleUntil;
    }

    Point PointerClientPoint() {
        var screenPoint = Cursor.Position;
        return new Point(screenPoint.X - Bounds.Left, screenPoint.Y - Bounds.Top);
    }

    bool PointerOnThisScreen() {
        var point = Cursor.Position;
        return PointerActive() && Bounds.Contains(point.X, point.Y);
    }

    Rectangle PointerHaloRect() {
        var point = PointerClientPoint();
        int radius = Scale(18);
        return new Rectangle(point.X - radius, point.Y - radius, radius * 2, radius * 2);
    }

    Region PointerHaloRegion() {
        var outerRect = PointerHaloRect();
        using (var outerPath = new GraphicsPath()) {
            outerPath.AddEllipse(outerRect);
            var ring = new Region(outerPath);
            int ringWidth = Scale(5);
            var innerRect = Rectangle.Inflate(outerRect, -ringWidth, -ringWidth);
            if (innerRect.Width > 1 && innerRect.Height > 1) {
                using (var innerPath = new GraphicsPath()) {
                    innerPath.AddEllipse(innerRect);
                    ring.Exclude(innerPath);
                }
            }
            return ring;
        }
    }

    public void ShowAutomationPointer(int durationMs) {
        int bounded = Math.Max(120, Math.Min(1500, durationMs));
        long ticks = (long)Math.Round((bounded / 1000.0) * Stopwatch.Frequency);
        pointerVisibleUntil = Stopwatch.GetTimestamp() + ticks;
        UpdateWindowRegion();
        Invalidate();
    }

    Rectangle BadgeRect() {
        int width = Scale(228);
        int height = Scale(28);
        int top = Scale(12);
        return new Rectangle(Math.Max(0, (ClientSize.Width - width) / 2), top, width, height);
    }

    static GraphicsPath RoundedRect(Rectangle rect, int radius) {
        var path = new GraphicsPath();
        int diameter = Math.Max(2, Math.Min(Math.Min(rect.Width, rect.Height), radius * 2));
        var arc = new Rectangle(rect.X, rect.Y, diameter, diameter);
        path.AddArc(arc, 180, 90);
        arc.X = rect.Right - diameter;
        path.AddArc(arc, 270, 90);
        arc.Y = rect.Bottom - diameter;
        path.AddArc(arc, 0, 90);
        arc.X = rect.Left;
        path.AddArc(arc, 90, 90);
        path.CloseFigure();
        return path;
    }

    void UpdateWindowRegion() {
        if (ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
        var next = new Region();
        next.MakeEmpty();
        if (showBadge) {
            using (var badgePath = RoundedRect(BadgeRect(), Scale(7))) next.Union(badgePath);
        }
        if (rippleActive) {
            using (var rippleRegion = RippleRingRegion()) next.Union(rippleRegion);
        }
        if (PointerOnThisScreen()) {
            using (var pointerRegion = PointerHaloRegion()) next.Union(pointerRegion);
        }
        var previous = Region;
        Region = next;
        if (previous != null) previous.Dispose();
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        try {
            var value = GetDpiForWindow(Handle);
            if (value >= 96) dpi = (int)value;
        } catch { dpi = 96; }
        UpdateWindowRegion();
        try { SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE); } catch { }
    }

    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        animationTimer.Start();
    }

    protected override void OnVisibleChanged(EventArgs e) {
        base.OnVisibleChanged(e);
        if (!Visible) animationTimer.Stop();
    }

    protected override void OnSizeChanged(EventArgs e) {
        base.OnSizeChanged(e);
        if (IsHandleCreated) UpdateWindowRegion();
    }

    protected override void Dispose(bool disposing) {
        if (disposing) {
            animationTimer.Stop();
            animationTimer.Dispose();
        }
        base.Dispose(disposing);
    }

    protected override void OnPaintBackground(PaintEventArgs e) {
    }

    protected override void OnPaint(PaintEventArgs e) {
        if (showBadge) {
            var badge = BadgeRect();
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var badgePath = RoundedRect(badge, Scale(7)))
            using (var badgeBrush = new SolidBrush(Color.FromArgb(28, 28, 30))) {
                e.Graphics.FillPath(badgeBrush, badgePath);
            }
            using (var font = new Font("Segoe UI", 9.0f, FontStyle.Bold, GraphicsUnit.Point)) {
                TextRenderer.DrawText(
                    e.Graphics,
                    "Computer Use  |  Esc to cancel",
                    font,
                    badge,
                    Color.White,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix
                );
            }
        }

        if (rippleActive) {
            double progress = RippleProgress();
            int alpha = Math.Max(0, Math.Min(255, (int)Math.Round(230.0 * (1.0 - progress))));
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(Color.FromArgb(alpha, 75, 180, 255), Math.Max(1, Scale(2)))) {
                e.Graphics.DrawEllipse(pen, RippleRect(progress));
            }
        }

        if (PointerOnThisScreen()) {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var halo = PointerHaloRect();
            using (var outer = new Pen(Color.FromArgb(210, 70, 175, 255), Math.Max(1, Scale(3))))
            using (var inner = new Pen(Color.FromArgb(150, 205, 235, 255), Math.Max(1, Scale(1)))) {
                e.Graphics.DrawEllipse(outer, halo);
                var innerRect = Rectangle.Inflate(halo, -Scale(4), -Scale(4));
                if (innerRect.Width > 1 && innerRect.Height > 1) e.Graphics.DrawEllipse(inner, innerRect);
            }
        }
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
    static string cancelFile;
    static IntPtr keyboardHook = IntPtr.Zero;
    static LowLevelKeyboardProc keyboardProc;
    static bool cancelRaised;

    const int WH_KEYBOARD_LL = 13;
    const int WM_KEYDOWN = 0x0100;
    const int WM_KEYUP = 0x0101;
    const int WM_SYSKEYDOWN = 0x0104;
    const int WM_SYSKEYUP = 0x0105;
    const int VK_ESCAPE = 0x1B;

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr hMod, uint threadId);
    [DllImport("user32.dll", SetLastError=true)]
    static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet=CharSet.Auto, SetLastError=true)]
    static extern IntPtr GetModuleHandle(string moduleName);

    static IntPtr KeyboardHookProc(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int message = wParam.ToInt32();
            int vk = Marshal.ReadInt32(lParam);
            if (vk == VK_ESCAPE && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN || message == WM_KEYUP || message == WM_SYSKEYUP)) {
                if (!cancelRaised && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)) {
                    cancelRaised = true;
                    try {
                        if (!String.IsNullOrWhiteSpace(cancelFile)) File.WriteAllText(cancelFile, DateTime.UtcNow.Ticks.ToString());
                    } catch { }
                }
                return new IntPtr(1);
            }
        }
        return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
    }

    static void ArmEscapeHookCore() {
        cancelRaised = false;
        if (keyboardHook != IntPtr.Zero) return;
        keyboardProc = KeyboardHookProc;
        var module = GetModuleHandle(null);
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
        if (keyboardHook == IntPtr.Zero) throw new InvalidOperationException("could not install local Esc cancellation hook");
    }

    static void DisarmEscapeHookCore() {
        cancelRaised = false;
        if (keyboardHook == IntPtr.Zero) return;
        try { UnhookWindowsHookEx(keyboardHook); } catch { }
        keyboardHook = IntPtr.Zero;
    }

    public static int Probe() {
        ComputerUseOverlayForm.EnableProcessDpiAwareness();
        return Screen.AllScreens.Length;
    }

    public static void EnsureStarted(int ownerPid, string signalPath) {
        ComputerUseOverlayForm.EnableProcessDpiAwareness();
        cancelFile = signalPath;
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
                DisarmEscapeHookCore();
                HideCore();
                Application.ExitThread();
            }
        };
        parentTimer.Start();

        var glowTimer = new System.Windows.Forms.Timer();
        glowTimer.Interval = 80;
        glowTimer.Tick += delegate {
            double seconds = (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency;
            double pulse = (Math.Sin((seconds / 2.6) * Math.PI * 2.0) + 1.0) / 2.0;
            foreach (var form in forms) {
                var glow = form as ComputerUseGlowBandForm;
                if (glow != null) glow.SetPulse(pulse);
            }
        };
        glowTimer.Start();

        ready.Set();
        Application.Run();
        glowTimer.Stop();
        glowTimer.Dispose();
        parentTimer.Stop();
        parentTimer.Dispose();
        HideCore();
        dispatcher.Dispose();
        dispatcher = null;
        visible = false;
    }

    static void AddGlowBands(Rectangle bounds) {
        // Adjacent translucent strips approximate a soft Codex-like bloom
        // without expanding/contracting hard geometry. The falloff reaches
        // roughly 33 px inward at 100% scale and fades rapidly toward content.
        int[] widths = new int[] { 2, 2, 3, 4, 5, 7, 10 };
        double[] opacities = new double[] { 0.50, 0.36, 0.25, 0.16, 0.10, 0.055, 0.025 };
        int offset = 0;
        for (int i = 0; i < widths.Length; i++) {
            int band = widths[i];
            double opacity = opacities[i];
            Rectangle[] strips = new Rectangle[] {
                new Rectangle(bounds.Left, bounds.Top + offset, bounds.Width, band),
                new Rectangle(bounds.Left, bounds.Bottom - offset - band, bounds.Width, band),
                new Rectangle(bounds.Left + offset, bounds.Top, band, bounds.Height),
                new Rectangle(bounds.Right - offset - band, bounds.Top, band, bounds.Height),
            };
            foreach (var strip in strips) {
                var glow = new ComputerUseGlowBandForm(strip, opacity);
                forms.Add(glow);
                glow.Show();
            }
            offset += band;
        }
    }

    static void ShowCore() {
        if (visible) return;
        HideCore();
        ComputerUseOverlayForm.EnableProcessDpiAwareness();
        foreach (var screen in Screen.AllScreens) {
            AddGlowBands(screen.Bounds);
            var overlay = new ComputerUseOverlayForm(screen.Bounds, screen.Primary);
            forms.Add(overlay);
            overlay.Show();
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

    public static void Show(int ownerPid, string signalPath) {
        EnsureStarted(ownerPid, signalPath);
        Invoke(ShowCore);
    }

    public static void ArmCancel() {
        Invoke(ArmEscapeHookCore);
    }

    public static void DisarmCancel() {
        var target = dispatcher;
        if (target == null || target.IsDisposed) return;
        Invoke(DisarmEscapeHookCore);
    }

    public static void PulseAt(int x, int y) {
        var target = dispatcher;
        if (target == null || target.IsDisposed) return;
        Invoke(delegate {
            foreach (var form in forms) {
                var overlay = form as ComputerUseOverlayForm;
                if (overlay != null) overlay.PulseAtScreen(x, y);
            }
        });
    }

    public static void ShowAutomationPointer(int durationMs) {
        var target = dispatcher;
        if (target == null || target.IsDisposed) return;
        Invoke(delegate {
            foreach (var form in forms) {
                var overlay = form as ComputerUseOverlayForm;
                if (overlay != null) overlay.ShowAutomationPointer(durationMs);
            }
        });
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
                DisarmEscapeHookCore();
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

[ComputerUseOverlayHost]::EnsureStarted($ParentPid, $CancelFile)
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
      'show' { [ComputerUseOverlayHost]::Show($ParentPid, $CancelFile); $result = @{ id=$id; ok=$true; visible=$true } }
      'hide' { [ComputerUseOverlayHost]::Hide(); $result = @{ id=$id; ok=$true; visible=$false } }
      'status' { $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }
      'armCancel' { [ComputerUseOverlayHost]::ArmCancel(); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }
      'disarmCancel' { [ComputerUseOverlayHost]::DisarmCancel(); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }
      'pulse' { [ComputerUseOverlayHost]::PulseAt([int]$payload.x, [int]$payload.y); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }
      'pointer' { [ComputerUseOverlayHost]::ShowAutomationPointer([int]$payload.durationMs); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }
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
const cancelSignalFile = path.join(os.tmpdir(), "chatgpt2codex", `computer-use-cancel-${process.pid}.signal`);
let cancelPollTimer: NodeJS.Timeout | undefined;
let cancelPollBusy = false;

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
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ParentPid", String(process.pid), "-CancelFile", cancelSignalFile],
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

async function requestHelper(
  op: HelperRequest["op"],
  payload: Pick<HelperRequest, "x" | "y" | "durationMs"> = {},
): Promise<HelperResponse> {
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
    child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      reject(error);
    });
  });
}

async function clearNativeCancelSignal(): Promise<void> {
  await fs.unlink(cancelSignalFile).catch(() => undefined);
}

function stopNativeCancelPolling(): void {
  if (!cancelPollTimer) return;
  clearInterval(cancelPollTimer);
  cancelPollTimer = undefined;
  cancelPollBusy = false;
}

function startNativeCancelPolling(): void {
  if (process.platform !== "win32" || testDriver !== undefined || cancelPollTimer) return;
  void clearNativeCancelSignal();
  cancelPollTimer = setInterval(() => {
    if (cancelPollBusy) return;
    cancelPollBusy = true;
    void fs.readFile(cancelSignalFile, "utf8").then(async () => {
      await clearNativeCancelSignal();
      signalComputerUseCancel("escape");
      await forceHideComputerUseActivity();
    }).catch(() => undefined).finally(() => {
      cancelPollBusy = false;
    });
  }, 75);
  cancelPollTimer.unref?.();
}

async function armNativeCancel(): Promise<void> {
  if (process.platform !== "win32" || testDriver !== undefined) return;
  await clearNativeCancelSignal();
  await requestHelper("armCancel");
  startNativeCancelPolling();
}

async function disarmNativeCancel(): Promise<void> {
  stopNativeCancelPolling();
  if (process.platform !== "win32" || testDriver !== undefined) return;
  if (helper && helper.exitCode === null && !helper.killed) {
    await requestHelper("disarmCancel").catch(() => undefined);
  }
  await clearNativeCancelSignal();
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
  const wasInactive = activeCount === 0;
  activeCount += 1;
  await queueTransition(syncVisibility);
  if (wasInactive) await armNativeCancel().catch(() => undefined);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount > 0) {
      await queueTransition(syncVisibility);
      return;
    }
    await disarmNativeCancel();
    cancelHideTimer();
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      void queueTransition(syncVisibility);
    }, idleHideMs);
    hideTimer.unref?.();
  };
}

export async function showComputerUseClickPulse(x: number, y: number): Promise<void> {
  if (process.platform !== "win32" || testDriver !== undefined) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  await requestHelper("pulse", { x: Math.round(x), y: Math.round(y) }).catch(() => undefined);
}

export async function showComputerUseAutomationPointer(durationMs = 650): Promise<void> {
  if (process.platform !== "win32" || testDriver !== undefined) return;
  const bounded = Math.max(120, Math.min(1500, Math.round(durationMs)));
  await requestHelper("pointer", { durationMs: bounded }).catch(() => undefined);
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
  await disarmNativeCancel();
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
  await disarmNativeCancel();
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
