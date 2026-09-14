import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import { revokeWorkerCapability } from "../agents/capability.js";
import { BrowserWorkerController, getBrowserWorkerSession, type BrowserWorkerDriver } from "../agents/browser-controller.js";
import { cancelAgent, getAgentStatus } from "../agents/manager.js";
import { addToolCallProof } from "./tool-proof.js";

export function registerWebAgentStopTool(server: McpServer, ctx: ToolContext, driver: BrowserWorkerDriver): void {
  server.registerTool(
    "agent_stop",
    {
      title: "Stop ChatGPT Web worker",
      description:
        "Stop a running Web worker, revoke its scoped worker access, and mark it cancelled while preserving its branch, worktree, and partial edits.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: ["chatgpt2codex"] }],
        ui: { visibility: ["model"] },
        "openai/visibility": "public",
        "openai/toolInvocation/invoking": "Stopping Web worker...",
        "openai/toolInvocation/invoked": "Web worker stopped",
      },
      inputSchema: {
        workerId: z.string().min(1),
        reason: z.string().optional(),
      },
    },
    async (input) => {
      try {
        await getAgentStatus(ctx.stateDir, input.workerId);
        await revokeWorkerCapability(ctx.stateDir, input.workerId).catch(() => undefined);

        const browser = await getBrowserWorkerSession(ctx.stateDir, input.workerId);
        let browserStopped = browser === null || browser.status === "stopped" || browser.status === "failed";
        if (!browserStopped) {
          const controller = new BrowserWorkerController(ctx.stateDir, driver);
          await controller.cancel(input.workerId).catch(() => undefined);
          browserStopped = true;
        }

        const worker = await cancelAgent(ctx.stateDir, input.workerId, input.reason);
        const result = makeResult(
          {
            workerId: worker.workerId,
            status: worker.status,
            browserStopped,
            workspaceRemoved: worker.workspace?.removedAt !== undefined,
          },
          `Worker ${worker.workerId} stopped and cancelled; its worktree was preserved.`,
        );
        return {
          ...result,
          structuredContent: addToolCallProof(result.structuredContent, "agent_stop", true),
        };
      } catch (error) {
        const domain = error instanceof DomainError
          ? error
          : new DomainError(ErrorCode.NOT_IMPLEMENTED, error instanceof Error ? error.message : String(error));
        const result = makeResult(
          { error: domain.message, code: domain.code, workerId: input.workerId },
          `Error [${domain.code}]: ${domain.message}`,
          true,
        );
        return {
          ...result,
          structuredContent: addToolCallProof(result.structuredContent, "agent_stop", false),
        };
      }
    },
  );
}
