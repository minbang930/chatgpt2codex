import { describe, expect, it } from "vitest";
import { isNetworkChatGptEnabled } from "./network.js";

describe("isNetworkChatGptEnabled", () => {
  it("defaults to disabled", () => {
    expect(isNetworkChatGptEnabled({})).toBe(false);
  });

  it("accepts explicit truthy owner opt-ins", () => {
    for (const value of ["1", "true", "TRUE", "on", "yes"]) {
      expect(isNetworkChatGptEnabled({ CHATGPT2CODEX_NETWORK_CHATGPT: value })).toBe(true);
    }
  });

  it("treats Full/Admin mode as an owner network opt-in", () => {
    expect(isNetworkChatGptEnabled({ CHATGPT2CODEX_CONTROL_ACCESS_MODE: "full" })).toBe(true);
  });

  it("keeps other values disabled", () => {
    for (const value of ["0", "false", "off", "no", ""]) {
      expect(isNetworkChatGptEnabled({ CHATGPT2CODEX_NETWORK_CHATGPT: value })).toBe(false);
    }
  });
});
