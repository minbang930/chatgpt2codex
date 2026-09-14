import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { DomainError, ErrorCode, type ProjectRegistryEntry, type ToolContext } from "../types.js";
import { registerTools } from "../server/tools.js";
import { findProject } from "../workspace/registry.js";
import { verifyWorkerCapability } from "./capability.js";
import { getAgentStatus, getAgentWorkspace } from "./manager.js";

/**
 * Small, explicit worker surface. Keep this narrower than normal Core so a
 * worker can inspect/edit/test/commit its own branch but cannot rescan/switch
 * projects, push remotes, control the desktop, or use unrelated media tools.
 */
export const WORKER_CORE_TOOL_NAMES = [
  "project_rules",
  "project_status",
  "repo_status",
  "repo_diff_summary",
  "code_search",
  "file_read_slice",
  "file_apply_patch",
  "file_create",
  "local_shell_run",
  "git_commit",
  "show_changes",
] as const;

export type WorkerCoreToolName = (typeof WORKER_CORE_TOOL_NAMES)[number];
const WORKER_CORE_TOOL_SET = new Set<string>(WORKER_CORE_TOOL_NAMES);

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<WorkerToolResult>;
}

export interface WorkerToolResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

async function originalProject(ctx: ToolContext, projectId: string): Promise<ProjectRegistryEntry> {
  let entries = ctx.registry;
  if (entries.length === 0) entries = await ctx.store.loadProjects();
  const found = findProject(entries, { projectId });
  if (!found.ok) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Worker project not found: ${projectId}`);
  }
  return found.entry;
}

/**
 * Build an isolated ToolContext for one authenticated worker. The context has
 * exactly one project, rooted at the managed worker worktree, and its session
 * lives only in memory. It never calls the base Store's setSession/saveProjects
 * paths, so worker tool calls cannot race the main ChatGPT active project.
 */
export async function createWorkerToolContext(
  baseCtx: ToolContext,
  workerToken: string,
): Promise<{ ctx: ToolContext; workerId: string; projectId: string; capabilityExpiresAt: number }> {
  const capability = await verifyWorkerCapability(baseCtx.stateDir, workerToken);
  const worker = await getAgentStatus(baseCtx.stateDir, capability.workerId);
  const sourceProject = await originalProject(baseCtx, worker.projectId);
  const workspace = await getAgentWorkspace(baseCtx.stateDir, sourceProject.root, worker.workerId);

  const scopedProject: ProjectRegistryEntry = {
    ...sourceProject,
    root: workspace.worktreePath,
    branch: workspace.branch,
    dirty: undefined,
    aliases: Array.from(new Set([...sourceProject.aliases, worker.workerId])),
  };
  const registry = [scopedProject];
  let session: Record<string, unknown> = {
    version: 1,
    updatedAt: Date.now(),
    activeProjectId: scopedProject.projectId,
    mode: "edit",
    lease: {
      projectId: scopedProject.projectId,
      leaseId: `worker_${worker.workerId}`,
      projectRoot: workspace.worktreePath,
      preset: "full-write",
      issuedAt: Date.now(),
      expiresAt: capability.expiresAt,
    },
  };

  const scopedCtx: ToolContext = {
    workspaceRoot: path.dirname(workspace.worktreePath),
    stateDir: baseCtx.stateDir,
    registry,
    ledger: baseCtx.ledger,
    store: {
      loadProjects: async () => registry,
      saveProjects: async (projects) => {
        registry.splice(0, registry.length, ...projects);
      },
      getSession: async () => session,
      setSession: async (next) => {
        // Intentionally local-only. Even if a future worker allowlist adds a
        // session-mutating Core tool, it still cannot alter global sessions.json.
        session = typeof next === "object" && next !== null ? { ...(next as Record<string, unknown>) } : {};
      },
    },
    config: {
      ...baseCtx.config,
      workspaceRoot: path.dirname(workspace.worktreePath),
      stateDir: baseCtx.stateDir,
    },
    // Treat worker dispatch as remote/untrusted for any Core guard that cares.
    remote: true,
  };

  return {
    ctx: scopedCtx,
    workerId: worker.workerId,
    projectId: scopedProject.projectId,
    capabilityExpiresAt: capability.expiresAt,
  };
}

/**
 * Invoke one explicitly allowed existing Core handler inside a worker-scoped
 * context. The caller never chooses projectId; it is injected from the
 * authenticated worker's durable assignment.
 */
export async function dispatchWorkerCoreTool(
  baseCtx: ToolContext,
  workerToken: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<WorkerToolResult> {
  if (!WORKER_CORE_TOOL_SET.has(toolName)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Core tool is not allowed for workers: ${toolName}`);
  }

  const scoped = await createWorkerToolContext(baseCtx, workerToken);
  const server = new McpServer({ name: "chatgpt2codex-worker-dispatch", version: "0.1.0" });
  registerTools(server, scoped.ctx);
  const tool = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools?.[toolName];
  if (!tool?.handler) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Worker Core tool is unavailable: ${toolName}`);
  }

  const safeInput = { ...input, projectId: scoped.projectId };
  await baseCtx.ledger.append({
    type: "worker.tool.started",
    workerId: scoped.workerId,
    projectId: scoped.projectId,
    tool: toolName,
  }).catch(() => undefined);

  const result = await tool.handler(safeInput);
  await baseCtx.ledger.append({
    type: "worker.tool.completed",
    workerId: scoped.workerId,
    projectId: scoped.projectId,
    tool: toolName,
    isError: result.isError === true,
  }).catch(() => undefined);
  return result;
}
