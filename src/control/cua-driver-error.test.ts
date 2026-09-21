import { describe, expect, it } from "vitest";
import { cuaToolResultError, cuaToolResultContentText } from "./cua-driver-error.js";

describe("Cua Driver error formatting", () => {
  it("preserves MCP content text alongside structured refusal diagnostics", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "window_id 42 belongs to pid 100, not pid 101.",
        },
      ],
      isError: true,
      structuredContent: {
        code: "tool_invocation_failed",
        execution_state: "unknown",
      },
    };

    expect(cuaToolResultContentText(result)).toBe(
      "window_id 42 belongs to pid 100, not pid 101.",
    );

    const error = cuaToolResultError(
      "get_window_state",
      result,
      result.structuredContent,
    );

    expect(error.message).toContain("window_id 42 belongs to pid 100, not pid 101.");
    expect(error.message).toContain('"code":"tool_invocation_failed"');
  });

  it("falls back to the structured payload when content text is absent", () => {
    const structured = {
      code: "tool_invocation_failed",
      execution_state: "unknown",
    };

    const error = cuaToolResultError(
      "get_window_state",
      { content: [], isError: true, structuredContent: structured },
      structured,
    );

    expect(error.message).toBe(
      'get_window_state failed: {"code":"tool_invocation_failed","execution_state":"unknown"}',
    );
  });

  it("joins multiple textual diagnostics and ignores non-text content", () => {
    const result = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "ignored" },
        { type: "text", text: "second" },
      ],
    };

    expect(cuaToolResultContentText(result)).toBe("first | second");
  });
});
