import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserWorkerDriver } from "../agents/browser-controller.js";
import type { ToolContext } from "../types.js";
import { registerWebAgentLaunchTool } from "./web-agent-launch-tool.js";

describe("agent_launch MCP metadata", () => {
  it("describes its external, non-destructive, non-idempotent side effects", () => {
    const server = new McpServer({ name: "agent-launch-metadata-test", version: "1" });
    const driver: BrowserWorkerDriver = {
      launch: async () => ({ browserHandle: "unused" }),
      cancel: async () => undefined,
    };

    registerWebAgentLaunchTool(server, {} as ToolContext, driver);

    const registered = (server as unknown as {
      _registeredTools?: Record<string, {
        description?: string;
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          idempotentHint?: boolean;
          openWorldHint?: boolean;
        };
      }>;
    })._registeredTools?.agent_launch;

    expect(registered?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(registered?.description).toContain("dedicated ChatGPT Web tab");
    expect(registered?.description).toContain("does not create a new worker");
    expect(registered?.description).toContain("isolated worktree");
  });
});
