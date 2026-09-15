import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureAppWindow,
  listVisibleWindows,
  resolveFrontmostApp,
  stopWindowsInputHelper,
  supportsLegacyKeyCodeOnWindows,
  windowsVirtualKeyForLegacyKeyCode,
} from "./win-native.js";

describe("control/win-native key translation", () => {
  it("preserves legacy keyCode semantics when translating common keys to Windows VK values", () => {
    expect(windowsVirtualKeyForLegacyKeyCode(0)).toBe(0x41); // A
    expect(windowsVirtualKeyForLegacyKeyCode(36)).toBe(0x0d); // Return
    expect(windowsVirtualKeyForLegacyKeyCode(48)).toBe(0x09); // Tab
    expect(windowsVirtualKeyForLegacyKeyCode(49)).toBe(0x20); // Space
    expect(windowsVirtualKeyForLegacyKeyCode(51)).toBe(0x08); // Backspace
    expect(windowsVirtualKeyForLegacyKeyCode(53)).toBe(0x1b); // Escape
    expect(windowsVirtualKeyForLegacyKeyCode(122)).toBe(0x70); // F1
    expect(windowsVirtualKeyForLegacyKeyCode(123)).toBe(0x25); // Left
    expect(windowsVirtualKeyForLegacyKeyCode(124)).toBe(0x27); // Right
    expect(windowsVirtualKeyForLegacyKeyCode(125)).toBe(0x28); // Down
    expect(windowsVirtualKeyForLegacyKeyCode(126)).toBe(0x26); // Up
  });

  it("rejects unmapped or invalid legacy key codes instead of reinterpreting them as Windows VK values", () => {
    expect(windowsVirtualKeyForLegacyKeyCode(10)).toBeUndefined();
    expect(windowsVirtualKeyForLegacyKeyCode(127)).toBeUndefined();
    expect(windowsVirtualKeyForLegacyKeyCode(-1)).toBeUndefined();
    expect(windowsVirtualKeyForLegacyKeyCode(36.5)).toBeUndefined();
    expect(supportsLegacyKeyCodeOnWindows(36)).toBe(true);
    expect(supportsLegacyKeyCodeOnWindows(10)).toBe(false);
  });
});

if (process.platform === "win32") {
  describe("control/win-native persistent helper", () => {
    afterAll(async () => {
      await stopWindowsInputHelper();
    });

    it("serves repeated read-only foreground queries without injecting desktop input", async () => {
      const first = await resolveFrontmostApp();
      const second = await resolveFrontmostApp();
      expect(first === undefined || typeof first === "string").toBe(true);
      expect(second === undefined || typeof second === "string").toBe(true);
    }, 150_000);

    it("enumerates visible top-level windows without exposing native HWND values", async () => {
      const windows = await listVisibleWindows();
      expect(windows.length).toBeLessThanOrEqual(200);
      expect(new Set(windows.map((window) => window.windowId)).size).toBe(windows.length);

      for (const window of windows) {
        expect(window.windowId).toMatch(/^window-\d+$/);
        expect(Number.isInteger(window.processId)).toBe(true);
        expect(window.processId).toBeGreaterThan(0);
        expect(window.processName.trim().length).toBeGreaterThan(0);
        expect(window.appName.trim().length).toBeGreaterThan(0);
        expect(window.title.trim().length).toBeGreaterThan(0);
        expect(window.visible).toBe(true);
        expect(typeof window.minimized).toBe("boolean");
        expect(typeof window.foreground).toBe("boolean");
        expect(window.dpi).toBeGreaterThan(0);
        expect(window.scaleFactor).toBeGreaterThan(0);
        expect(Number.isFinite(window.bounds.x)).toBe(true);
        expect(Number.isFinite(window.bounds.y)).toBe(true);
        expect(window.bounds.width).toBeGreaterThan(0);
        expect(window.bounds.height).toBeGreaterThan(0);
        expect(Object.prototype.hasOwnProperty.call(window, "hwnd")).toBe(false);
      }
    }, 30_000);

    it("routes app capture through the helper without capturing the CI desktop for a missing target", async () => {
      const file = path.join(os.tmpdir(), `chatgpt2codex-missing-${Date.now()}.png`);
      await expect(captureAppWindow("chatgpt2codex-app-that-does-not-exist", file)).rejects.toThrow(
        /target app window not found/i,
      );
      expect(existsSync(file)).toBe(false);
    }, 30_000);
  });
}
