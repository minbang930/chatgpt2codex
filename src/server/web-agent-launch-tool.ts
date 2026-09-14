import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import type { BrowserWorkerDriver } from "../agents/browser-controller.js";
import { launchPreparedBrowserWorker } from "../agents/browser-launch.js";
import { getAgentStatus } from "../agents/manager.js";
import { addToolCallProof } from "./tool-proof.js";
import { resolveActiveProject } from "../workspace/active.js";
import { requireProjectLease } from "../workspace/lease-guard.js";

const annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function registerWebAgentLaunchTool(
  server: McpServer,
  ctx: ToolContext,
  driver: BrowserWorkerDriver,
): void {
  server.registerTool(
    "agent_launch",
    {
      title: "Launch prepared ChatGPT worker",
      description:
        "Start a pending worker prepared by agent_spawn in a dedicated ChatGPT Web tab. Call this immediately after agent_spawn. The tool returns after bootstrap submission; the worker continues asynchronously.",
      annotations,
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: ["chatgpt2codex"] }],
        ui: { visibility: ["model"] },
        "openai/visibility": "public",
        "openai/toolInvocation/invoking": "Launching ChatGPT worker...",
        "openai/toolInvocation/invoked": "ChatGPT worker launched",
      },
      inputSchema: { workerId: z.string().min(1) },
    },
    async (input) => {
      try {
        const active = await resolveActiveProject(ctx);
        if (!active) {
          throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "No active project; call project_select first");
        }
        await requireProjectLease(ctx, active.projectId, "write");
        const worker = await getAgentStatus(ctx.stateDir, input.workerId);
        if (worker.projectId !== active.projectId) {
          throw new DomainError(ErrorCode.PERMISSION_DENIED, `Worker ${worker.workerId} belongs to another project`);
        }

        const launched = await launchPreparedBrowserWorker(ctx.stateDir, driver, worker.workerId);
        const result = makeResult(
          {
            workerId: launched.worker.workerId,
            projectId: launched.worker.projectId,
            status: launched.worker.status,
            branch: launched.worker.workspace?.branch,
            browserStatus: launched.browser.status,
            browserAttempt: launched.browser.attempt,
            browserRoute: launched.browser.route.mode,
            projectUrl:
              launched.browser.route.mode === "project" ? launched.browser.route.projectRef.url : undefined,
            capabilityExpiresAt: launched.capabilityExpiresAt,
          },
          `Worker ${launched.worker.workerId} is running asynchronously in a dedicated ChatGPT Web chat.`,
        );
        return {
          ...result,
          structuredContent: addToolCallProof(result.structuredContent, "agent_launch", true),
        };
      } catch (error) {
        const domain = error instanceof DomainError
          ? error
          : new DomainError(ErrorCode.NOT_IMPLEMENTED, error instanceof Error ? error.message : String(error));
        const result = makeResult(
          {
            error: domain.message,
            code: domain.code,
            workerId: input.workerId,
            retryable: true,
          },
          `Error [${domain.code}]: ${domain.message}`,
          true,
        );
        return {
          ...result,
          structuredContent: addToolCallProof(result.structuredContent, "agent_launch", false),
        };
      }
    },
  );
}
