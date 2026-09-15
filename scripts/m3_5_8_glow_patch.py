from pathlib import Path

p = Path('src/control/activity-indicator.ts')
s = p.read_text(encoding='utf-8')

marker = 'public sealed class ComputerUseOverlayForm : Form {\n'
if marker not in s:
    raise SystemExit('overlay class marker missing')

glow_class = r'''public sealed class ComputerUseGlowBandForm : Form {
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

'''
s = s.replace(marker, glow_class + marker, 1)

old_region = '        foreach (var rect in BorderRects(CurrentBorderThickness())) next.Union(rect);\n'
if old_region not in s:
    raise SystemExit('border region marker missing')
s = s.replace(old_region, '', 1)

old_paint_prefix = '''        double pulse = ActivityPulse();\n        int green = 105 + (int)Math.Round(35.0 * pulse);\n        int blue = 190 + (int)Math.Round(50.0 * pulse);\n        var accent = Color.FromArgb(0, Math.Min(255, green), Math.Min(255, blue));\n        using (var accentBrush = new SolidBrush(accent)) {\n            foreach (var rect in BorderRects(CurrentBorderThickness())) e.Graphics.FillRectangle(accentBrush, rect);\n        }\n\n'''
if old_paint_prefix not in s:
    raise SystemExit('animated border paint marker missing')
s = s.replace(old_paint_prefix, '', 1)

old_badge = '''        if (showBadge) {\n            var badge = BadgeRect();\n            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;\n            int badgeLevel = 26 + (int)Math.Round(8.0 * pulse);\n            using (var badgePath = RoundedRect(badge, Scale(7)))\n            using (var badgeBrush = new SolidBrush(Color.FromArgb(badgeLevel, badgeLevel, badgeLevel + 2)))\n            using (var badgePen = new Pen(accent, Math.Max(1, Scale(1)))) {\n                e.Graphics.FillPath(badgeBrush, badgePath);\n                e.Graphics.DrawPath(badgePen, badgePath);\n            }\n            using (var font = new Font("Segoe UI", 9.0f, FontStyle.Bold, GraphicsUnit.Point)) {\n                TextRenderer.DrawText(\n                    e.Graphics,\n                    "Computer Use  |  Esc to cancel",\n                    font,\n                    badge,\n                    Color.White,\n                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix\n                );\n            }\n        }\n'''
new_badge = '''        if (showBadge) {\n            var badge = BadgeRect();\n            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;\n            using (var badgePath = RoundedRect(badge, Scale(7)))\n            using (var badgeBrush = new SolidBrush(Color.FromArgb(28, 28, 30))) {\n                e.Graphics.FillPath(badgeBrush, badgePath);\n            }\n            using (var font = new Font("Segoe UI", 9.0f, FontStyle.Bold, GraphicsUnit.Point)) {\n                TextRenderer.DrawText(\n                    e.Graphics,\n                    "Computer Use  |  Esc to cancel",\n                    font,\n                    badge,\n                    Color.White,\n                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix\n                );\n            }\n        }\n'''
if old_badge not in s:
    raise SystemExit('badge paint marker missing')
s = s.replace(old_badge, new_badge, 1)

old_uimain = '''        parentTimer.Start();\n        ready.Set();\n        Application.Run();\n        parentTimer.Stop();\n        parentTimer.Dispose();\n'''
new_uimain = '''        parentTimer.Start();\n\n        var glowTimer = new System.Windows.Forms.Timer();\n        glowTimer.Interval = 80;\n        glowTimer.Tick += delegate {\n            double seconds = (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency;\n            double pulse = (Math.Sin((seconds / 2.6) * Math.PI * 2.0) + 1.0) / 2.0;\n            foreach (var form in forms) {\n                var glow = form as ComputerUseGlowBandForm;\n                if (glow != null) glow.SetPulse(pulse);\n            }\n        };\n        glowTimer.Start();\n\n        ready.Set();\n        Application.Run();\n        glowTimer.Stop();\n        glowTimer.Dispose();\n        parentTimer.Stop();\n        parentTimer.Dispose();\n'''
if old_uimain not in s:
    raise SystemExit('UiMain timer marker missing')
s = s.replace(old_uimain, new_uimain, 1)

old_showcore = '''    static void ShowCore() {\n        if (visible) return;\n        HideCore();\n        ComputerUseOverlayForm.EnableProcessDpiAwareness();\n        foreach (var screen in Screen.AllScreens) {\n            var overlay = new ComputerUseOverlayForm(screen.Bounds, screen.Primary);\n            forms.Add(overlay);\n            overlay.Show();\n        }\n        visible = true;\n    }\n'''
new_showcore = '''    static void AddGlowBands(Rectangle bounds) {\n        // Adjacent translucent strips approximate a soft Codex-like bloom\n        // without expanding/contracting hard geometry. The falloff reaches\n        // roughly 33 px inward at 100% scale and fades rapidly toward content.\n        int[] widths = new int[] { 2, 2, 3, 4, 5, 7, 10 };\n        double[] opacities = new double[] { 0.50, 0.36, 0.25, 0.16, 0.10, 0.055, 0.025 };\n        int offset = 0;\n        for (int i = 0; i < widths.Length; i++) {\n            int band = widths[i];\n            double opacity = opacities[i];\n            Rectangle[] strips = new Rectangle[] {\n                new Rectangle(bounds.Left, bounds.Top + offset, bounds.Width, band),\n                new Rectangle(bounds.Left, bounds.Bottom - offset - band, bounds.Width, band),\n                new Rectangle(bounds.Left + offset, bounds.Top, band, bounds.Height),\n                new Rectangle(bounds.Right - offset - band, bounds.Top, band, bounds.Height),\n            };\n            foreach (var strip in strips) {\n                var glow = new ComputerUseGlowBandForm(strip, opacity);\n                forms.Add(glow);\n                glow.Show();\n            }\n            offset += band;\n        }\n    }\n\n    static void ShowCore() {\n        if (visible) return;\n        HideCore();\n        ComputerUseOverlayForm.EnableProcessDpiAwareness();\n        foreach (var screen in Screen.AllScreens) {\n            AddGlowBands(screen.Bounds);\n            var overlay = new ComputerUseOverlayForm(screen.Bounds, screen.Primary);\n            forms.Add(overlay);\n            overlay.Show();\n        }\n        visible = true;\n    }\n'''
if old_showcore not in s:
    raise SystemExit('ShowCore marker missing')
s = s.replace(old_showcore, new_showcore, 1)

old_comment = ''' * The overlay uses one shaped topmost window per Windows display. Its region\n * contains an inset four-sided frame plus a small primary-display badge, so\n * right/bottom edges stay inside the physical display instead of being clipped.\n * Every window is\n'''
new_comment = ''' * The overlay uses translucent topmost glow bands plus one shaped interaction\n * overlay per Windows display. Glow intensity breathes while geometry stays\n * fixed; the primary-display badge remains intentionally static. Every window is\n'''
if old_comment in s:
    s = s.replace(old_comment, new_comment, 1)

p.write_text(s, encoding='utf-8')
