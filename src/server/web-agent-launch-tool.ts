import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import type { BrowserWorkerDriver } from "../agents/browser-controller.js";
import { launchPreparedBrowserWorker, recoverRunningBrowserWorker } from "../agents/browser-launch.js";
import { getAgentStatus } from "../agents/manager.js";
import { addToolCallProof } from "./tool-proof.js";
import { resolveActiveProject } from "../workspace/active.js";
import { requireProjectLease } from "../workspace/lease-guard.js";

const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerWebAgentLaunchTool(
  server: McpServer,
  ctx: ToolContext,
  driver: BrowserWorkerDriver,
): void {
  server.registerTool(
    "agent_launch",
    {
      title: "Launch or recover ChatGPT worker",
      description:
        "Launch an already-prepared pending worker, or recover an existing running worker whose browser target was lost/stopped. This opens a dedicated ChatGPT Web tab and submits the worker task/bootstrap to the connected ChatGPT To Codex Worker app. It does not create a new worker, delete data, or directly edit project files; the launched worker may later edit only its isolated worktree according to its assigned task. Returns after bootstrap submission while the worker continues asynchronously.",
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

        const recovery = worker.status === "running";
        const launched = recovery
          ? await recoverRunningBrowserWorker(ctx.stateDir, driver, worker.workerId)
          : await launchPreparedBrowserWorker(ctx.stateDir, driver, worker.workerId);
        const result = makeResult(
          {
            workerId: launched.worker.workerId,
            projectId: launched.worker.projectId,
            status: launched.worker.status,
            branch: launched.worker.workspace?.branch,
            browserStatus: launched.browser.status,
            browserAttempt: launched.browser.attempt,
            browserRoute: launched.browser.route.mode,
            recovered: recovery,
            projectUrl:
              launched.browser.route.mode === "project" ? launched.browser.route.projectRef.url : undefined,
            capabilityExpiresAt: launched.capabilityExpiresAt,
          },
          recovery
            ? `Worker ${launched.worker.workerId} recovered in a fresh ChatGPT Web chat and remains running asynchronously.`
            : `Worker ${launched.worker.workerId} is running asynchronously in a dedicated ChatGPT Web chat.`,
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
