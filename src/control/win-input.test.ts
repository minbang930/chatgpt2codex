import { describe, expect, it } from "vitest";
import {
  resolveFrontmostApp,
  supportsLegacyKeyCodeOnWindows,
  windowsVirtualKeyForLegacyKeyCode,
} from "./win-input.js";

describe("control/win-input key translation", () => {
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

  if (process.platform === "win32") {
    it("loads the native helper for a read-only foreground query without injecting input", async () => {
      const appName = await resolveFrontmostApp();
      expect(appName === undefined || typeof appName === "string").toBe(true);
    }, 15_000);
  }
});
