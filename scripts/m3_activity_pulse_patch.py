from pathlib import Path

# M3.5.5: subtle breathing border/badge + coordinate-click ripple.
p = Path('src/control/activity-indicator.ts')
s = p.read_text(encoding='utf-8')

# Helper request can carry a click location.
s = s.replace(
    '  op: "show" | "hide" | "status" | "armCancel" | "disarmCancel" | "shutdown";\n}',
    '  op: "show" | "hide" | "status" | "armCancel" | "disarmCancel" | "pulse" | "shutdown";\n  x?: number;\n  y?: number;\n}',
    1,
)

# Overlay fields: lightweight 20fps animation and transient click ripple.
old = '''    readonly bool showBadge;\n    int dpi = 96;\n'''
new = '''    readonly bool showBadge;\n    readonly System.Windows.Forms.Timer animationTimer;\n    int dpi = 96;\n    bool rippleActive;\n    Point ripplePoint;\n    long rippleStartedAt;\n    const double ActivityPeriodSeconds = 1.6;\n    const double RippleDurationSeconds = 0.62;\n'''
if old not in s:
    raise SystemExit('overlay field marker missing')
s = s.replace(old, new, 1)

# Start an animation timer once the form exists. It only invalidates the thin shaped region.
old = '''        DoubleBuffered = true;\n        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);\n    }\n'''
new = '''        DoubleBuffered = true;\n        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);\n        animationTimer = new System.Windows.Forms.Timer();\n        animationTimer.Interval = 50;\n        animationTimer.Tick += delegate {\n            if (rippleActive && RippleProgress() >= 1.0) rippleActive = false;\n            UpdateWindowRegion();\n            Invalidate();\n        };\n    }\n'''
if old not in s:
    raise SystemExit('overlay constructor marker missing')
s = s.replace(old, new, 1)

# Replace fixed border geometry with breathing geometry + ripple helpers.
start = s.index('    Rectangle[] BorderRects() {')
end = s.index('\n\n    Rectangle BadgeRect()', start)
replacement = r'''    double ActivityPulse() {
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
    }'''
s = s[:start] + replacement + s[end:]

# Region follows the subtle thickness change and contains only the ripple ring, not its center.
old = '''        foreach (var rect in BorderRects()) next.Union(rect);\n        if (showBadge) {'''
new = '''        foreach (var rect in BorderRects(CurrentBorderThickness())) next.Union(rect);\n        if (showBadge) {'''
if old not in s:
    raise SystemExit('region border marker missing')
s = s.replace(old, new, 1)
old = '''        if (showBadge) {\n            using (var badgePath = RoundedRect(BadgeRect(), Scale(7))) next.Union(badgePath);\n        }\n        var previous = Region;'''
new = '''        if (showBadge) {\n            using (var badgePath = RoundedRect(BadgeRect(), Scale(7))) next.Union(badgePath);\n        }\n        if (rippleActive) {\n            using (var rippleRegion = RippleRingRegion()) next.Union(rippleRegion);\n        }\n        var previous = Region;'''
if old not in s:
    raise SystemExit('region badge marker missing')
s = s.replace(old, new, 1)

# Start/stop the timer with the visual lifetime.
old = '''    protected override void OnSizeChanged(EventArgs e) {\n        base.OnSizeChanged(e);\n        if (IsHandleCreated) UpdateWindowRegion();\n    }\n\n    protected override void OnPaintBackground(PaintEventArgs e) {'''
new = '''    protected override void OnShown(EventArgs e) {\n        base.OnShown(e);\n        animationTimer.Start();\n    }\n\n    protected override void OnVisibleChanged(EventArgs e) {\n        base.OnVisibleChanged(e);\n        if (!Visible) animationTimer.Stop();\n    }\n\n    protected override void OnSizeChanged(EventArgs e) {\n        base.OnSizeChanged(e);\n        if (IsHandleCreated) UpdateWindowRegion();\n    }\n\n    protected override void Dispose(bool disposing) {\n        if (disposing) {\n            animationTimer.Stop();\n            animationTimer.Dispose();\n        }\n        base.Dispose(disposing);\n    }\n\n    protected override void OnPaintBackground(PaintEventArgs e) {'''
if old not in s:
    raise SystemExit('overlay lifecycle marker missing')
s = s.replace(old, new, 1)

# Paint breathing frame/badge and the transient click ring.
start = s.index('    protected override void OnPaint(PaintEventArgs e) {')
end = s.index('\n\n    protected override void WndProc', start)
paint = r'''    protected override void OnPaint(PaintEventArgs e) {
        double pulse = ActivityPulse();
        int green = 105 + (int)Math.Round(35.0 * pulse);
        int blue = 190 + (int)Math.Round(50.0 * pulse);
        var accent = Color.FromArgb(0, Math.Min(255, green), Math.Min(255, blue));
        using (var accentBrush = new SolidBrush(accent)) {
            foreach (var rect in BorderRects(CurrentBorderThickness())) e.Graphics.FillRectangle(accentBrush, rect);
        }

        if (showBadge) {
            var badge = BadgeRect();
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int badgeLevel = 26 + (int)Math.Round(8.0 * pulse);
            using (var badgePath = RoundedRect(badge, Scale(7)))
            using (var badgeBrush = new SolidBrush(Color.FromArgb(badgeLevel, badgeLevel, badgeLevel + 2)))
            using (var badgePen = new Pen(accent, Math.Max(1, Scale(1)))) {
                e.Graphics.FillPath(badgeBrush, badgePath);
                e.Graphics.DrawPath(badgePen, badgePath);
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
    }'''
s = s[:start] + paint + s[end:]

# Host forwards click pulses to the overlay that contains the screen point.
old = '''    public static void DisarmCancel() {\n        var target = dispatcher;\n        if (target == null || target.IsDisposed) return;\n        Invoke(DisarmEscapeHookCore);\n    }\n\n    public static void Hide() {'''
new = '''    public static void DisarmCancel() {\n        var target = dispatcher;\n        if (target == null || target.IsDisposed) return;\n        Invoke(DisarmEscapeHookCore);\n    }\n\n    public static void PulseAt(int x, int y) {\n        var target = dispatcher;\n        if (target == null || target.IsDisposed) return;\n        Invoke(delegate {\n            foreach (var form in forms) {\n                var overlay = form as ComputerUseOverlayForm;\n                if (overlay != null) overlay.PulseAtScreen(x, y);\n            }\n        });\n    }\n\n    public static void Hide() {'''
if old not in s:
    raise SystemExit('host DisarmCancel marker missing')
s = s.replace(old, new, 1)

# PowerShell helper command.
old = "      'disarmCancel' { [ComputerUseOverlayHost]::DisarmCancel(); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }\n      'shutdown' {"
new = "      'disarmCancel' { [ComputerUseOverlayHost]::DisarmCancel(); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }\n      'pulse' { [ComputerUseOverlayHost]::PulseAt([int]$payload.x, [int]$payload.y); $result = @{ id=$id; ok=$true; visible=[ComputerUseOverlayHost]::IsVisible() } }\n      'shutdown' {"
if old not in s:
    raise SystemExit('PowerShell pulse command marker missing')
s = s.replace(old, new, 1)

# Node request helper now takes a small typed cosmetic payload.
old = '''async function requestHelper(op: HelperRequest["op"]): Promise<HelperResponse> {\n  const child = await startHelper();\n  const id = nextRequestId++;\n  return new Promise((resolve, reject) => {'''
new = '''async function requestHelper(\n  op: HelperRequest["op"],\n  payload: Pick<HelperRequest, "x" | "y"> = {},\n): Promise<HelperResponse> {\n  const child = await startHelper();\n  const id = nextRequestId++;\n  return new Promise((resolve, reject) => {'''
if old not in s:
    raise SystemExit('requestHelper signature marker missing')
s = s.replace(old, new, 1)
s = s.replace(
    '    child.stdin.write(`${JSON.stringify({ id, op })}\\n`, (error) => {',
    '    child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\\n`, (error) => {',
    1,
)

# Public best-effort visual action feedback. It never changes authorization or actuation.
marker = '''export async function withComputerUseActivity<T>(fn: () => Promise<T>): Promise<T> {\n  const release = await beginComputerUseActivity();'''
insert = '''export async function showComputerUseClickPulse(x: number, y: number): Promise<void> {\n  if (process.platform !== "win32" || testDriver !== undefined) return;\n  if (!Number.isFinite(x) || !Number.isFinite(y)) return;\n  await requestHelper("pulse", { x: Math.round(x), y: Math.round(y) }).catch(() => undefined);\n}\n\nexport async function withComputerUseActivity<T>(fn: () => Promise<T>): Promise<T> {\n  const release = await beginComputerUseActivity();'''
if marker not in s:
    raise SystemExit('withComputerUseActivity marker missing')
s = s.replace(marker, insert, 1)
p.write_text(s, encoding='utf-8')

# Coordinate clicks show a transient ripple after the real click succeeds.
p = Path('src/control/input-backend.ts')
s = p.read_text(encoding='utf-8')
s = s.replace(
    'import { withComputerUseActivity } from "./activity-indicator.js";',
    'import { showComputerUseClickPulse, withComputerUseActivity } from "./activity-indicator.js";',
    1,
)
old = '    return withComputerUseActivity(() => winInput.clickAtPoint(appName, x, y));'
new = '''    return withComputerUseActivity(async () => {\n      await winInput.clickAtPoint(appName, x, y);\n      await showComputerUseClickPulse(x, y);\n    });'''
if old not in s:
    raise SystemExit('Windows click marker missing')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')

# Remove the one-off M3.5.4 CI trigger artifact now that that unit is green.
trigger = Path('docs/.m3-5-4-ci-trigger')
if trigger.exists():
    trigger.unlink()
