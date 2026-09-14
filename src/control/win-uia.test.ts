import { afterAll, describe, expect, it } from "vitest";
import {
  parseUiaSemanticTarget,
  snapshotSemanticElements,
  stopWindowsUiaHelper,
} from "./win-uia.js";

describe("control/win-uia semantic reference", () => {
  it("accepts only observation-scoped opaque UIA labels", () => {
    const parsed = parseUiaSemanticTarget({
      role: "Button",
      label: "uiaref:uiaobs_0123456789abcdef0123456789abcdef:uiael_7",
    });
    expect(parsed).toEqual({
      observationId: "uiaobs_0123456789abcdef0123456789abcdef",
      elementId: "uiael_7",
      role: "Button",
    });

    expect(parseUiaSemanticTarget({ role: "Button", label: "uiael_7" })).toBeUndefined();
    expect(parseUiaSemanticTarget({ role: "Button", label: "uiaref:uiaobs_bad:uiael_7" })).toBeUndefined();
    expect(parseUiaSemanticTarget({ role: "Button", label: "uiaref:uiaobs_0123456789abcdef0123456789abcdef:uiael_0" })).toBeUndefined();
    expect(parseUiaSemanticTarget({ role: "Button" })).toBeUndefined();
  });
});

if (process.platform === "win32") {
  describe("control/win-uia persistent helper", () => {
    afterAll(async () => {
      await stopWindowsUiaHelper();
    });

    it("loads UI Automation and rejects a deliberately nonexistent target without observing unrelated desktop content", async () => {
      await expect(
        snapshotSemanticElements("chatgpt2codex-definitely-missing-window-5d77212e"),
      ).rejects.toThrow(/target app window not found/i);
    }, 75_000);
  });
}
