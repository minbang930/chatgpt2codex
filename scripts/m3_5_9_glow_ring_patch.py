from pathlib import Path
import re

path = Path('src/control/activity-indicator.ts')
text = path.read_text(encoding='utf-8')

new_class = r'''public sealed class ComputerUseGlowRingForm : Form {
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
    readonly int logicalThickness;
    int dpi = 96;

    [DllImport("user32.dll")]
    static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr hWnd);

    public ComputerUseGlowRingForm(Rectangle bounds, int thickness, double opacity) {
        logicalThickness = Math.Max(1, thickness);
        baseOpacity = Math.Max(0.005, Math.Min(0.30, opacity));
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Color.FromArgb(0, 120, 240);
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

    int Scale(int logicalPixels) {
        return Math.Max(1, (int)Math.Round(logicalPixels * Math.Max(96, dpi) / 96.0));
    }

    void UpdateRingRegion() {
        int width = Math.Max(1, ClientSize.Width);
        int height = Math.Max(1, ClientSize.Height);
        int thickness = Math.Max(1, Math.Min(Scale(logicalThickness), Math.Min(width, height) / 2));
        var next = new Region(new Rectangle(0, 0, width, height));
        var inner = new Rectangle(
            thickness,
            thickness,
            Math.Max(0, width - (2 * thickness)),
            Math.Max(0, height - (2 * thickness))
        );
        if (inner.Width > 0 && inner.Height > 0) next.Exclude(inner);
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
        UpdateRingRegion();
        try { SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE); } catch { }
    }

    protected override void OnSizeChanged(EventArgs e) {
        base.OnSizeChanged(e);
        if (IsHandleCreated) UpdateRingRegion();
    }

    public void SetPulse(double pulse) {
        // Geometry stays fixed. Only a very small luminance/opacity breath is
        // applied so the edge reads as ambient light rather than a moving line.
        double bounded = Math.Max(0.0, Math.Min(1.0, pulse));
        double multiplier = 0.84 + (0.24 * bounded);
        Opacity = Math.Max(0.005, Math.Min(0.32, baseOpacity * multiplier));
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_NCHITTEST) { m.Result = HTTRANSPARENT; return; }
        if (m.Msg == WM_MOUSEACTIVATE) { m.Result = MA_NOACTIVATE; return; }
        base.WndProc(ref m);
    }
}

public sealed class ComputerUseOverlayForm : Form {'''

text, count = re.subn(
    r'public sealed class ComputerUseGlowBandForm : Form \{.*?public sealed class ComputerUseOverlayForm : Form \{',
    new_class,
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f'glow class replacement count={count}')

text = text.replace('var glow = form as ComputerUseGlowBandForm;', 'var glow = form as ComputerUseGlowRingForm;')

new_add = r'''    static void AddGlowBands(Rectangle bounds) {
        // Three nested full-screen rings create a symmetric edge halo on every
        // side. The wide low-opacity bloom carries the light inward, a medium
        // ring adds body, and the tiny core highlight remains deliberately dim.
        // Because every layer is one ring rather than four edge windows, the
        // left/top and right/bottom geometry cannot diverge or clip differently.
        int[] thicknesses = new int[] { 36, 18, 3 };
        double[] opacities = new double[] { 0.035, 0.060, 0.075 };
        for (int i = 0; i < thicknesses.Length; i++) {
            var glow = new ComputerUseGlowRingForm(bounds, thicknesses[i], opacities[i]);
            forms.Add(glow);
            glow.Show();
        }
    }

    static void ShowCore() {'''

text, count = re.subn(
    r'    static void AddGlowBands\(Rectangle bounds\) \{.*?    static void ShowCore\(\) \{',
    new_add,
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f'AddGlowBands replacement count={count}')

text = text.replace(
    'The overlay uses translucent topmost glow bands plus one shaped interaction\n * overlay per Windows display.',
    'The overlay uses three nested translucent glow rings plus one shaped interaction\n * overlay per Windows display.'
)

path.write_text(text, encoding='utf-8')
