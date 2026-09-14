import { spawn } from "node:child_process";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";

export interface AppWindowRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowsHelperResult {
  ok?: boolean;
  appName?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface WindowsHelperPayload {
  op: "frontmost" | "windowRect" | "click" | "type" | "key";
  appName?: string;
  x?: number;
  y?: number;
  text?: string;
  virtualKey?: number;
}

const WINDOWS_HELPER_TIMEOUT_MS = 10_000;

/**
 * The existing public control tool exposes the legacy macOS virtual-key-code
 * namespace. Preserve that wire contract and translate the common keys to
 * Windows virtual-key values instead of silently reinterpreting the number.
 */
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

function assertWin32(): void {
  if (process.platform !== "win32") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Windows desktop input is only supported on Windows");
  }
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// Static script only. User/model-controlled values are sent as one JSON line
// on stdin, never interpolated into the PowerShell argv, so typed text cannot
// become PowerShell/C# source or leak through exec argv error messages.
const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadLine() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class ChatGpt2CodexWinInput {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const int SW_RESTORE = 9;
    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    static Process WindowProcess(IntPtr hWnd) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid == 0) return null;
        try { return Process.GetProcessById((int)pid); } catch { return null; }
    }

    static string Description(Process process) {
        if (process == null) return null;
        try {
            var description = process.MainModule.FileVersionInfo.FileDescription;
            if (!String.IsNullOrWhiteSpace(description)) return description.Trim();
            var product = process.MainModule.FileVersionInfo.ProductName;
            if (!String.IsNullOrWhiteSpace(product)) return product.Trim();
        } catch { }
        return process.ProcessName;
    }

    static bool Match(Process process, string requested) {
        if (process == null || String.IsNullOrWhiteSpace(requested)) return false;
        var needle = requested.Trim();
        if (needle.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) needle = needle.Substring(0, needle.Length - 4);
        if (String.Equals(process.ProcessName, needle, StringComparison.OrdinalIgnoreCase)) return true;
        var description = Description(process);
        return !String.IsNullOrWhiteSpace(description) && String.Equals(description, requested.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    public static string ForegroundAppName() {
        var process = WindowProcess(GetForegroundWindow());
        return Description(process);
    }

    public static IntPtr FindWindow(string appName) {
        var foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero && IsWindowVisible(foreground) && Match(WindowProcess(foreground), appName)) return foreground;

        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            var process = WindowProcess(hWnd);
            if (Match(process, appName)) { found = hWnd; return false; }
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
        var hWnd = Activate(appName);
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new InvalidOperationException("could not read target app window bounds");
        return rect;
    }

    public static void Click(string appName, int x, int y) {
        Activate(appName);
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("could not move pointer");
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        inputs[1].type = INPUT_MOUSE;
        inputs[1].U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput mouse click failed");
    }

    public static void TypeUnicode(string appName, string text) {
        Activate(appName);
        if (String.IsNullOrEmpty(text)) return;
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (char ch in text) {
            var down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.U.ki.wScan = ch;
            down.U.ki.dwFlags = KEYEVENTF_UNICODE;
            inputs.Add(down);
            var up = down;
            up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            inputs.Add(up);
        }
        var array = inputs.ToArray();
        if (SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT))) != array.Length) throw new InvalidOperationException("SendInput Unicode text failed");
    }

    public static void PressKey(string appName, ushort virtualKey) {
        Activate(appName);
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = virtualKey;
        inputs[1] = inputs[0];
        inputs[1].U.ki.dwFlags = KEYEVENTF_KEYUP;
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput key failed");
    }
}
'@

switch ([string]$payload.op) {
  'frontmost' {
    @{ appName = [ChatGpt2CodexWinInput]::ForegroundAppName() } | ConvertTo-Json -Compress
  }
  'windowRect' {
    $r = [ChatGpt2CodexWinInput]::RectForApp([string]$payload.appName)
    @{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) } | ConvertTo-Json -Compress
  }
  'click' {
    [ChatGpt2CodexWinInput]::Click([string]$payload.appName, [int]$payload.x, [int]$payload.y)
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  'type' {
    [ChatGpt2CodexWinInput]::TypeUnicode([string]$payload.appName, [string]$payload.text)
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  'key' {
    [ChatGpt2CodexWinInput]::PressKey([string]$payload.appName, [uint16]$payload.virtualKey)
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  default { throw 'unsupported Windows input operation' }
}
`;

function runWindowsHelper(payload: WindowsHelperPayload): Promise<WindowsHelperResult> {
  assertWin32();
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_HELPER_SCRIPT],
      { env: buildSafeChildEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Windows desktop input helper timed out"));
    }, WINDOWS_HELPER_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Windows desktop input helper exited ${code}: ${stderr.trim() || "unknown error"}`));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout.trim()) as WindowsHelperResult : { ok: true });
      } catch {
        reject(new Error("Windows desktop input helper returned invalid JSON"));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

export async function resolveFrontmostApp(): Promise<string | undefined> {
  const result = await runWindowsHelper({ op: "frontmost" });
  const name = result.appName?.trim();
  return name || undefined;
}

export async function getAppWindowRegion(appName: string): Promise<AppWindowRegion> {
  const result = await runWindowsHelper({ op: "windowRect", appName });
  const values = [result.x, result.y, result.width, result.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Windows desktop input helper returned invalid window bounds");
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
  return {
    x: Math.round(region.x + region.width * xRel),
    y: Math.round(region.y + region.height * yRel),
  };
}

export async function clickAtPoint(appName: string, x: number, y: number): Promise<void> {
  await runWindowsHelper({ op: "click", appName, x: Math.round(x), y: Math.round(y) });
}

export async function typeText(appName: string, text: string): Promise<void> {
  await runWindowsHelper({ op: "type", appName, text });
}

export async function pressKey(appName: string, keyCode: number): Promise<void> {
  const virtualKey = windowsVirtualKeyForLegacyKeyCode(keyCode);
  if (virtualKey === undefined) {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `Legacy keyCode ${keyCode} does not have a Windows mapping yet`,
    );
  }
  await runWindowsHelper({ op: "key", appName, virtualKey });
}
