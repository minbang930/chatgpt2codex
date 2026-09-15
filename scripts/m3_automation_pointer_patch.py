from pathlib import Path

# M3.5.6: smooth real pointer movement + safe overlay halo that follows the
# real Windows cursor. We intentionally do not replace/hide the system cursor.

# --- Activity overlay pointer visualization ---
p = Path('src/control/activity-indicator.ts')
s = p.read_text(encoding='utf-8')
s = s.replace(
    '  op: "show" | "hide" | "status" | "armCancel" | "disarmCancel" | "pulse" | "shutdown";\n  x?: number;\n  y?: number;',
    '  op: "show" | "hide" | "status" | "armCancel" | "disarmCancel" | "pulse" | "pointer" | "shutdown";\n  x?: number;\n  y?: number;\n  durationMs?: number;',
    1,
)

old = '''    bool rippleActive;\n    Point ripplePoint;\n    long rippleStartedAt;\n    const double ActivityPeriodSeconds = 1.6;'''
new = '''    bool rippleActive;\n    Point ripplePoint;\n    long rippleStartedAt;\n    long pointerVisibleUntil;\n    const double ActivityPeriodSeconds = 1.6;'''
if old not in s:
    raise SystemExit('overlay pointer field marker missing')
s = s.replace(old, new, 1)
s = s.replace('        animationTimer.Interval = 50;', '        animationTimer.Interval = 33;', 1)

# Add pointer helpers immediately after click-ripple trigger.
old = '''    public void PulseAtScreen(int x, int y) {\n        if (!Bounds.Contains(x, y)) return;\n        ripplePoint = new Point(x - Bounds.Left, y - Bounds.Top);\n        rippleStartedAt = Stopwatch.GetTimestamp();\n        rippleActive = true;\n        UpdateWindowRegion();\n        Invalidate();\n    }\n\n    Rectangle BadgeRect() {'''
new = r'''    public void PulseAtScreen(int x, int y) {
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

    Rectangle BadgeRect() {'''
if old not in s:
    raise SystemExit('ripple method marker missing')
s = s.replace(old, new, 1)

# Include only the halo ring in the shaped window, so no opaque disc follows the cursor.
old = '''        if (rippleActive) {\n            using (var rippleRegion = RippleRingRegion()) next.Union(rippleRegion);\n        }\n        var previous = Region;'''
new = '''        if (rippleActive) {\n            using (var rippleRegion = RippleRingRegion()) next.Union(rippleRegion);\n        }\n        if (PointerOnThisScreen()) {\n            using (var pointerRegion = PointerHaloRegion()) next.Union(pointerRegion);\n        }\n        var previous = Region;'''
if old not in s:
    raise SystemExit('pointer region marker missing')
s = s.replace(old, new, 1)

# Paint a distinctive but non-invasive halo around the one real system cursor.
old = '''        if (rippleActive) {\n            double progress = RippleProgress();\n            int alpha = Math.Max(0, Math.Min(255, (int)Math.Round(230.0 * (1.0 - progress))));\n            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;\n            using (var pen = new Pen(Color.FromArgb(alpha, 75, 180, 255), Math.Max(1, Scale(2)))) {\n                e.Graphics.DrawEllipse(pen, RippleRect(progress));\n            }\n        }\n    }'''
new = '''        if (rippleActive) {\n            double progress = RippleProgress();\n            int alpha = Math.Max(0, Math.Min(255, (int)Math.Round(230.0 * (1.0 - progress))));\n            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;\n            using (var pen = new Pen(Color.FromArgb(alpha, 75, 180, 255), Math.Max(1, Scale(2)))) {\n                e.Graphics.DrawEllipse(pen, RippleRect(progress));\n            }\n        }\n\n        if (PointerOnThisScreen()) {\n            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;\n            var halo = PointerHaloRect();\n            using (var outer = new Pen(Color.FromArgb(210, 70, 175, 255), Math.Max(1, Scale(3))))\n            using (var inner = new Pen(Color.FromArgb(150, 205, 235, 255), Math.Max(1, Scale(1)))) {\n                e.Graphics.DrawEllipse(outer, halo);\n                var innerRect = Rectangle.Inflate(halo, -Scale(4), -Scale(4));\n                if (innerRect.Width > 1 && innerRect.Height > 1) e.Graphics.DrawEllipse(inner, innerRect);\n            }\n        }\n    }'''
if old not in s:
    raise SystemExit('pointer paint marker missing')
s = s.replace(old, new, 1)

# Host forwards a short pointer-visualization lease to all monitor overlays.
old = '''    public static void PulseAt(int x, int y) {\n        var target = dispatcher;\n        if (target == null || target.IsDisposed) return;\n        Invoke(delegate {\n            foreach (var form in forms) {\n                var overlay = form as ComputerUseOverlayForm;\n                if (overlay != null) overlay.PulseAtScreen(x, y);\n            }\n        });\n    }\n\n    public static void Hide() {'''
new = '''    public static void PulseAt(int x, int y) {\n        var target = dispatcher;\n        if (target == null || target.IsDisposed) return;\n        Invoke(delegate {\n            foreach (var form in forms) {\n                var overlay = form as ComputerUseOverlayForm;\n                if (overlay != null) overlay.PulseAtScreen(x, y);\n            }\n        });\n    }\n\n    public static void ShowAutomationPointer(int durationMs) {\n        var target = dispatcher;\n        if (target == null || target.IsDisposed) return;\n        Invoke(delegate {\n            foreach (var form in forms) {\n                var overlay = form as ComputerUseOverlayForm;\n                if (overlay != null) overlay.ShowAutomationPointer(durationMs);\n            }\n        });\n    }\n\n    public static void Hide() {'''
if old not in s:
    raise SystemExit('host pulse marker missing')
s = s.replace(old, new, 1)

old = "      'pulse' { [ComputerUseOverlayHost]::PulseAt([int]$payload.x, [int]$payload.y); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }\n      'shutdown' {"
new = "      'pulse' { [ComputerUseOverlayHost]::PulseAt([int]$payload.x, [int]$payload.y); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }\n      'pointer' { [ComputerUseOverlayHost]::ShowAutomationPointer([int]$payload.durationMs); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }\n      'shutdown' {"
if old not in s:
    raise SystemExit('PowerShell pointer command marker missing')
s = s.replace(old, new, 1)

old = '  payload: Pick<HelperRequest, "x" | "y"> = {},'
new = '  payload: Pick<HelperRequest, "x" | "y" | "durationMs"> = {},'
if old not in s:
    raise SystemExit('request payload marker missing')
s = s.replace(old, new, 1)

# Public cosmetic helper used immediately before a real coordinate movement.
old = '''export async function showComputerUseClickPulse(x: number, y: number): Promise<void> {\n  if (process.platform !== "win32" || testDriver !== undefined) return;\n  if (!Number.isFinite(x) || !Number.isFinite(y)) return;\n  await requestHelper("pulse", { x: Math.round(x), y: Math.round(y) }).catch(() => undefined);\n}\n\nexport async function withComputerUseActivity<T>(fn: () => Promise<T>): Promise<T> {'''
new = '''export async function showComputerUseClickPulse(x: number, y: number): Promise<void> {\n  if (process.platform !== "win32" || testDriver !== undefined) return;\n  if (!Number.isFinite(x) || !Number.isFinite(y)) return;\n  await requestHelper("pulse", { x: Math.round(x), y: Math.round(y) }).catch(() => undefined);\n}\n\nexport async function showComputerUseAutomationPointer(durationMs = 650): Promise<void> {\n  if (process.platform !== "win32" || testDriver !== undefined) return;\n  const bounded = Math.max(120, Math.min(1500, Math.round(durationMs)));\n  await requestHelper("pointer", { durationMs: bounded }).catch(() => undefined);\n}\n\nexport async function withComputerUseActivity<T>(fn: () => Promise<T>): Promise<T> {'''
if old not in s:
    raise SystemExit('public pulse marker missing')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')

# --- Real Windows pointer movement: smooth, still the authoritative system cursor ---
p = Path('src/control/win-native.ts')
s = p.read_text(encoding='utf-8')
old = '    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }\n'
new = old + '    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\n'
if old not in s:
    raise SystemExit('POINT struct marker missing')
s = s.replace(old, new, 1)
s = s.replace(
    '    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);\n',
    '    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);\n    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);\n',
    1,
)
old = '''    public static void Click(string appName, int x, int y) {\n        Activate(appName);\n        if (!SetCursorPos(x, y)) throw new InvalidOperationException("could not move pointer");\n        var inputs = new INPUT[2];'''
new = r'''    static void MovePointerSmooth(int x, int y) {
        POINT start;
        if (!GetCursorPos(out start)) {
            if (!SetCursorPos(x, y)) throw new InvalidOperationException("could not move pointer");
            return;
        }
        int dx = x - start.X;
        int dy = y - start.Y;
        double distance = Math.Sqrt((double)dx * dx + (double)dy * dy);
        int steps = Math.Max(5, Math.Min(16, (int)Math.Ceiling(distance / 70.0)));
        for (int i = 1; i <= steps; i++) {
            double t = (double)i / steps;
            double eased = t * t * (3.0 - (2.0 * t));
            int nextX = start.X + (int)Math.Round(dx * eased);
            int nextY = start.Y + (int)Math.Round(dy * eased);
            if (!SetCursorPos(nextX, nextY)) throw new InvalidOperationException("could not move pointer");
            if (i < steps) Thread.Sleep(12);
        }
    }

    public static void Click(string appName, int x, int y) {
        Activate(appName);
        MovePointerSmooth(x, y);
        var inputs = new INPUT[2];'''
if old not in s:
    raise SystemExit('Click movement marker missing')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')

# --- Coordinate click orchestration: show halo before motion, ripple after click. ---
p = Path('src/control/input-backend.ts')
s = p.read_text(encoding='utf-8')
s = s.replace(
    'import { showComputerUseClickPulse, withComputerUseActivity } from "./activity-indicator.js";',
    'import { showComputerUseAutomationPointer, showComputerUseClickPulse, withComputerUseActivity } from "./activity-indicator.js";',
    1,
)
old = '''    return withComputerUseActivity(async () => {\n      await winInput.clickAtPoint(appName, x, y);\n      await showComputerUseClickPulse(x, y);\n    });'''
new = '''    return withComputerUseActivity(async () => {\n      await showComputerUseAutomationPointer(650);\n      await winInput.clickAtPoint(appName, x, y);\n      await showComputerUseClickPulse(x, y);\n    });'''
if old not in s:
    raise SystemExit('coordinate click orchestration marker missing')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
