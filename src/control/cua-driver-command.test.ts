import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cuaDriverVariant,
  defaultFastPathCuaDriverBin,
  resolveCuaDriverCommand,
} from "./cua-driver-command.js";

describe("Cua Driver runtime selector", () => {
  it("uses the system Driver by default", () => {
    expect(resolveCuaDriverCommand({}, { exists: () => false })).toEqual({
      command: "cua-driver",
      source: "system",
      variant: "system",
    });
  });

  it("keeps CUA_DRIVER_BIN as the highest-priority explicit override", () => {
    const resolved = resolveCuaDriverCommand(
      {
        CUA_DRIVER_BIN: "C:\\custom\\cua-driver.exe",
        CHATGPT2CODEX_CUA_DRIVER_VARIANT: "fast-path",
      },
      { exists: () => false },
    );
    expect(resolved).toEqual({
      command: "C:\\custom\\cua-driver.exe",
      source: "explicit",
      variant: "fast-path",
    });
  });

  it("resolves the persisted fast-path Driver when explicitly selected", () => {
    const home = "C:\\Users\\tester";
    const expected = path.join(
      home,
      ".local",
      "share",
      "chatgpt2codex",
      "cua-driver",
      "fast-path",
      "cua-driver.exe",
    );
    const resolved = resolveCuaDriverCommand(
      { CHATGPT2CODEX_CUA_DRIVER_VARIANT: "fast-path" },
      { homeDir: home, platform: "win32", exists: (file) => file === expected },
    );
    expect(resolved).toEqual({
      command: expected,
      source: "fast-path",
      variant: "fast-path",
    });
  });

  it("supports an explicit fast-path install location", () => {
    const resolved = resolveCuaDriverCommand(
      {
        CHATGPT2CODEX_CUA_DRIVER_VARIANT: "fast-path",
        CHATGPT2CODEX_CUA_FAST_PATH_BIN: "D:\\drivers\\cua-driver.exe",
      },
      { exists: (file) => file === "D:\\drivers\\cua-driver.exe" },
    );
    expect(resolved.command).toBe("D:\\drivers\\cua-driver.exe");
    expect(resolved.source).toBe("fast-path");
  });

  it("fails closed when fast-path is selected but unavailable", () => {
    expect(() =>
      resolveCuaDriverCommand(
        { CHATGPT2CODEX_CUA_DRIVER_VARIANT: "fast-path" },
        { homeDir: "C:\\Users\\tester", platform: "win32", exists: () => false },
      ),
    ).toThrow(/patched Driver was not found/i);
  });

  it("rejects unknown variants", () => {
    expect(() => cuaDriverVariant({ CHATGPT2CODEX_CUA_DRIVER_VARIANT: "mystery" })).toThrow(
      /expected system or fast-path/i,
    );
  });

  it("builds the default persisted path deterministically", () => {
    expect(defaultFastPathCuaDriverBin("C:\\Users\\tester", "win32")).toContain(
      path.join("chatgpt2codex", "cua-driver", "fast-path", "cua-driver.exe"),
    );
  });
});
