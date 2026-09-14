import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DomainError,
  ErrorCode,
  makeResult,
  type ProjectRegistryEntry,
  type ToolContext,
  type ToolResult,
} from "../types.js";
import {
  acknowledgeAgentEvent,
  cancelAgent,
  getAgentResult,
  getAgentStatus,
  getAgentWorkspace,
  spawnAgent,
  waitForAgentEvents,
} from "../agents/manager.js";
import { completeWorker, type WorkerRecord, type WorkerResult } from "../agents/store.js";
import { addToolCallProof } from "./tool-proof.js";
import { redact } from "../policy/secrets.js";
import { resolveActiveProject } from "../workspace/active.js";
import { findProject } from "../workspace/registry.js";
import { requireProjectLease } from "../workspace/lease-guard.js";

const SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const LOCAL_STATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

interface CallToolResultLike {
  content: ToolResult["content"];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

function chatGptMeta(invoking: string, invoked: string): Record<string, unknown> {
  return {
    securitySchemes: SECURITY_SCHEMES,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

function redactUnknown(value: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(value)));
  } catch {
    return undefined;
  }
}

function mapError(err: unknown): ToolResult<{ error: string; code: string; details?: unknown }> {
  if (err instanceof DomainError) {
    const message = redact(err.message);
    return makeResult(
      { error: message, code: err.code, details: redactUnknown(err.details) },
      `Error [${err.code}]: ${message}`,
      true,
    );
  }
  const message = redact(err instanceof Error ? err.message : String(err));
  return makeResult(
    { error: message, code: ErrorCode.NOT_IMPLEMENTED },
    `Error: ${message}`,
    true,
  );
}

function toCallToolResult(toolName: string, result: ToolResult<Record<string, unknown>>): CallToolResultLike {
  return {
    content: result.content,
    structuredContent: addToolCallProof(result.structuredContent, toolName, result.isError !== true),
    ...(result.isError ? { isError: true } : {}),
    ...(result._meta ? { _meta: result._meta } : {}),
  };
}

async function withErrorMapping<T extends Record<string, unknown>>(
  ctx: ToolContext,
  toolName: string,
  auditInput: unknown,
  fn: () => Promise<ToolResult<T>>,
): Promise<CallToolResultLike> {
  try {
    const result = await fn();
    await ctx.ledger.append({
      type: "tool.call.completed",
      tool: toolName,
      input: redactUnknown(auditInput),
      isError: result.isError ?? false,
    });
    return toCallToolResult(toolName, result);
  } catch (err) {
    const mapped = mapError(err);
    await ctx.ledger.append({
      type: "tool.call.failed",
      tool: toolName,
      input: redactUnknown(auditInput),
      code: mapped.structuredContent.code,
      error: mapped.structuredContent.error,
    });
    return toCallToolResult(toolName, mapped);
  }
}

async function projectById(ctx: ToolContext, projectId: string): Promise<ProjectRegistryEntry> {
  let entries = ctx.registry;
  if (entries.length === 0) {
    entries = await ctx.store.loadProjects();
  }
  const found = findProject(entries, { projectId });
  if (!found.ok) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${projectId}`);
  }
  return found.entry;
}

function workerView(worker: WorkerRecord): Record<string, unknown> {
  return {
    workerId: worker.workerId,
    projectId: worker.projectId,
    task: worker.task,
    status: worker.status,
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
    startedAt: worker.startedAt,
    finishedAt: worker.finishedAt,
    branch: worker.workspace?.branch,
    baseCommit: worker.workspace?.baseCommit,
    workspaceRemoved: worker.workspace?.removedAt !== undefined,
    error: worker.error,
    notification: worker.notification
      ? {
          eventId: worker.notification.eventId,
          status: worker.notification.status,
          createdAt: worker.notification.createdAt,
          notifiedAt: worker.notification.notifiedAt,
        }
      : undefined,
  };
}

/** Register the custom-runtime multi-agent MCP surface. */
export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  const registerTool = server.registerTool.bind(server);

  registerTool(
    "agent_spawn",
    {
      title: "Prepare isolated coding worker",
      description:
        "Create a durable worker plus its isolated Git branch/worktree for the active full-write project. In M1 this prepares the worker only; ChatGPT Web worker launch is added in M2, so do not claim the task is running until the worker becomes running.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptMeta("Preparing isolated worker...", "Isolated worker prepared"),
      inputSchema: {
        task: z.string().min(1),
        baseRef: z.string().min(1).optional(),
      },
    },
    async (input) =>
      withErrorMapping(ctx, "agent_spawn", { ...input, task: "[task redacted]" }, async () => {
        const active = await resolveActiveProject(ctx);
        if (!active) {
          throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "No active project; call project_select first");
        }
        await requireProjectLease(ctx, active.projectId, "write");
        const worker = await spawnAgent(ctx.stateDir, {
          project: { projectId: active.projectId, root: active.root },
          task: input.task,
          baseRef: input.baseRef,
        });
        return makeResult(
          {
            ...workerView(worker),
            launchState: "prepared",
          },
          `Worker ${worker.workerId} prepared on ${worker.workspace?.branch ?? "managed branch"}. Browser worker launch is not active yet.`,
        );
      }),
  );

  registerTool(
    "agent_status",
    {
      title: "Get worker status",
      description: "Read the durable status and workspace metadata for one local worker.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptMeta("Checking worker status...", "Worker status loaded"),
      inputSchema: { workerId: z.string().min(1) },
    },
    async (input) =>
      withErrorMapping(ctx, "agent_status", input, async () => {
        const worker = await getAgentStatus(ctx.stateDir, input.workerId);
        return makeResult(workerView(worker), `Worker ${worker.workerId}: ${worker.status}.`);
      }),
  );

  registerTool(
    "agent_result",
    {
      title: "Get worker result",
      description: "Read a worker's durable final result/error without deleting it from the local inbox.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptMeta("Loading worker result...", "Worker result loaded"),
      inputSchema: { workerId: z.string().min(1) },
    },
    async (input) =>
      withErrorMapping(ctx, "agent_result", input, async () => {
        const result = await getAgentResult(ctx.stateDir, input.workerId);
        return makeResult(
          { ...result },
          result.status === "completed"
            ? `Worker ${result.workerId} completed: ${result.result?.summary ?? "no summary"}`
            : `Worker ${result.workerId}: ${result.status}${result.error ? ` (${result.error})` : ""}.`,
        );
      }),
  );

  registerTool(
    "agent_wait",
    {
      title: "Wait briefly for worker update",
      description:
        "Wait up to 60 seconds for one or more unnotified worker completion/failure/cancellation events. This is an event wait; use agent_result for the full durable result.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptMeta("Waiting for worker update...", "Worker update wait finished"),
      inputSchema: {
        workerIds: z.array(z.string().min(1)).max(32).optional(),
        timeoutMs: z.number().int().min(0).max(60_000).optional(),
      },
    },
    async (input) =>
      withErrorMapping(ctx, "agent_wait", input, async () => {
        const waited = await waitForAgentEvents(ctx.stateDir, input);
        const events = waited.events.map((event) => ({
          workerId: event.worker.workerId,
          status: event.notification.status,
          eventId: event.notification.eventId,
        }));
        for (const event of waited.events) {
          await acknowledgeAgentEvent(ctx.stateDir, event.notification.eventId);
        }
        return makeResult(
          { timedOut: waited.timedOut, events },
          waited.timedOut
            ? "No new worker event arrived before the wait timed out."
            : `${events.length} worker event(s) available; use agent_result for full results.`,
        );
      }),
  );

  registerTool(
    "agent_cancel",
    {
      title: "Cancel coding worker",
      description:
        "Mark a worker cancelled without deleting its branch, worktree, or partial edits. Browser/process interruption is added when Web workers are implemented.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptMeta("Cancelling worker...", "Worker cancelled"),
      inputSchema: {
        workerId: z.string().min(1),
        reason: z.string().optional(),
      },
    },
    async (input) =>
      withErrorMapping(ctx, "agent_cancel", input, async () => {
        const worker = await cancelAgent(ctx.stateDir, input.workerId, input.reason);
        return makeResult(workerView(worker), `Worker ${worker.workerId} cancelled; its worktree was preserved.`);
      }),
  );

  registerTool(
    "worker_finish",
    {
      title: "Finish coding worker",
      description:
        "Worker-side completion handshake. Persist the final summary/result in the durable inbox after verifying the worker still owns its managed worktree. If commitSha is supplied it must match the worker worktree HEAD.",
      securitySchemes: SECURITY_SCHEMES,
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptMeta("Recording worker completion...", "Worker completion recorded"),
      inputSchema: {
        workerId: z.string().min(1),
        summary: z.string().min(1),
        commitSha: z.string().min(1).optional(),
        changedFiles: z.array(z.string()).optional(),
        checks: z.array(z.string()).optional(),
        remainingIssues: z.array(z.string()).optional(),
      },
    },
    async (input) =>
      withErrorMapping(
        ctx,
        "worker_finish",
        { ...input, summary: "[summary redacted]" },
        async () => {
          const worker = await getAgentStatus(ctx.stateDir, input.workerId);
          const project = await projectById(ctx, worker.projectId);
          const workspace = await getAgentWorkspace(ctx.stateDir, project.root, worker.workerId);
          if (input.commitSha && input.commitSha.toLowerCase() !== workspace.head.toLowerCase()) {
            throw new DomainError(
              ErrorCode.WORKSPACE_NOT_READY,
              `Worker commitSha does not match worktree HEAD: expected ${workspace.head}`,
            );
          }

          const result: WorkerResult = {
            summary: input.summary,
            commitSha: input.commitSha,
            changedFiles: input.changedFiles,
            checks: input.checks,
            remainingIssues: input.remainingIssues,
          };
          const completed = await completeWorker(ctx.stateDir, worker.workerId, result);
          return makeResult(
            {
              ...workerView(completed),
              result: completed.result,
            },
            `Worker ${completed.workerId} completion stored in the durable inbox.`,
          );
        },
      ),
  );
}
