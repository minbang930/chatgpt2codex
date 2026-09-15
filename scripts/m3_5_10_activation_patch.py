from pathlib import Path
import re

path = Path('src/control/win-native.ts')
text = path.read_text(encoding='utf-8')

old_point = '[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\n'
new_point = old_point + '''    [StructLayout(LayoutKind.Sequential)] public struct MSG {\n        public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam;\n        public uint time; public POINT pt; public uint lPrivate;\n    }\n'''
if old_point not in text:
    raise SystemExit('POINT struct anchor missing')
text = text.replace(old_point, new_point, 1)

old_imports = '''    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();\n    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);\n'''
new_imports = '''    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();\n    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);\n    [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);\n    [DllImport("user32.dll", EntryPoint="SwitchToThisWindow")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);\n'''
if old_imports not in text:
    raise SystemExit('activation import anchor missing')
text = text.replace(old_imports, new_imports, 1)

new_activation = r'''    static bool WaitForForeground(IntPtr hWnd, int timeoutMs) {
        var sw = Stopwatch.StartNew();
        do {
            if (GetForegroundWindow() == hWnd) return true;
            Thread.Sleep(25);
        } while (sw.ElapsedMilliseconds < timeoutMs);
        return GetForegroundWindow() == hWnd;
    }

    static void EnsureMessageQueue() {
        // AttachThreadInput is substantially more reliable when the helper
        // thread owns a Win32 message queue. PeekMessage creates it lazily.
        MSG ignored;
        PeekMessage(out ignored, IntPtr.Zero, 0, 0, 0);
    }

    static void NudgeForegroundPermission() {
        // Windows can reject SetForegroundWindow for a background helper even
        // after the user has authorized control. A tiny Alt down/up is the
        // standard foreground-lock nudge; it does not type text or target an
        // arbitrary window and is used only after the exact allowlisted target
        // has already been resolved.
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD; inputs[0].U.ki.wVk = 0x12;
        inputs[1] = inputs[0]; inputs[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static bool TryActivateWithAttachedQueues(IntPtr hWnd, int waitMs) {
        EnsureMessageQueue();
        ShowWindowAsync(hWnd, SW_RESTORE);
        Thread.Sleep(40);

        uint ignoredPid;
        uint currentThread = GetCurrentThreadId();
        IntPtr foregroundWindow = GetForegroundWindow();
        uint foregroundThread = foregroundWindow == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foregroundWindow, out ignoredPid);
        uint targetThread = GetWindowThreadProcessId(hWnd, out ignoredPid);
        bool attachedForeground = false;
        bool attachedTarget = false;
        bool attachedForegroundTarget = false;

        try {
            if (foregroundThread != 0 && foregroundThread != currentThread)
                attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
            if (targetThread != 0 && targetThread != currentThread)
                attachedTarget = AttachThreadInput(currentThread, targetThread, true);
            if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread)
                attachedForegroundTarget = AttachThreadInput(foregroundThread, targetThread, true);

            BringWindowToTop(hWnd);
            SetActiveWindow(hWnd);
            SetForegroundWindow(hWnd);
            SetFocus(hWnd);
        } finally {
            if (attachedForegroundTarget) AttachThreadInput(foregroundThread, targetThread, false);
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }

        return WaitForForeground(hWnd, waitMs);
    }

    static string ForegroundDiagnostic() {
        var hWnd = GetForegroundWindow();
        if (hWnd == IntPtr.Zero) return "none";
        var process = WindowProcess(hWnd);
        var processName = ProcessName(process) ?? "unknown";
        var title = WindowTitle(hWnd) ?? "untitled";
        return processName + " / " + title;
    }

    public static IntPtr Activate(string appName) {
        var hWnd = FindWindow(appName);
        if (hWnd == IntPtr.Zero) throw new InvalidOperationException("target app window not found");
        if (GetForegroundWindow() == hWnd) return hWnd;

        // First try the least invasive, queue-attached foreground path.
        if (TryActivateWithAttachedQueues(hWnd, 350)) return hWnd;

        // Give Windows' foreground-lock policy one explicit user-input nudge,
        // then repeat the exact-window activation attempt.
        NudgeForegroundPermission();
        if (TryActivateWithAttachedQueues(hWnd, 500)) return hWnd;

        // SwitchToThisWindow is the same task-switch primitive used by desktop
        // shells/task managers. It is reserved as a last activation fallback;
        // the resolved allowlisted HWND is still verified afterward before any
        // mouse/keyboard input is emitted.
        try {
            ShowWindowAsync(hWnd, SW_RESTORE);
            SwitchToThisWindow(hWnd, true);
        } catch { }
        if (WaitForForeground(hWnd, 700)) return hWnd;

        // One final attached-queue verification attempt handles apps that
        // recreate/settle their input queue during restore/task switching.
        if (TryActivateWithAttachedQueues(hWnd, 500)) return hWnd;

        throw new InvalidOperationException(
            "target app did not become foreground after verified activation attempts; synthetic input refused (foreground="
            + ForegroundDiagnostic() + ")"
        );
    }
'''

text, count = re.subn(
    r'    static bool WaitForForeground\(IntPtr hWnd, int timeoutMs\) \{.*?    public static RECT RectForApp\(string appName\) \{',
    new_activation + '    public static RECT RectForApp(string appName) {',
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f'activation block replacement count={count}')

path.write_text(text, encoding='utf-8')
