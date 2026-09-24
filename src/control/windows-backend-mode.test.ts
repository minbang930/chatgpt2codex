import { describe, expect, it } from "vitest";
import { isCuaWindowsBackend, windowsBackendMode } from "./windows-backend-mode.js";

describe("windows backend mode", () => {
  it("keeps the existing backend as the default", () => {
    expect(windowsBackendMode({})).toBe("legacy");
  });

  it("selects Cua only when explicitly requested", () => {
    expect(windowsBackendMode({ CHATGPT2CODEX_WINDOWS_BACKEND: "cua" })).toBe("cua");
    expect(isCuaWindowsBackend("win32", { CHATGPT2CODEX_WINDOWS_BACKEND: "cua" })).toBe(true);
    expect(isCuaWindowsBackend("darwin", { CHATGPT2CODEX_WINDOWS_BACKEND: "cua" })).toBe(false);
  });

  it("fails closed on unknown backend names", () => {
    expect(() => windowsBackendMode({ CHATGPT2CODEX_WINDOWS_BACKEND: "magic" })).toThrow(
      /expected legacy or cua/,
    );
  });
});
