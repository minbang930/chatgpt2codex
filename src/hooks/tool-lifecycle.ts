import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { auditHookDispatch, auditHookUnexpectedError, getHookEngine } from "./runtime.js";

interface CallToolResultLike {
  isError?: boolean;
  [key: string]: unknown;
}

interface RegisteredToolLike {
  handler?: (...args: unknown[]) => Promise<CallToolResultLike>;
}

interface ActiveProjectContext {
  projectId?: string;
  projectRoot?: string;
}

function boundedProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 200);
}

function requestedProjectId(args: unknown[]): string | undefined {
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return boundedProjectId((input as { projectId?: unknown }).projectId);
}

async function readActiveProjectContext(ctx: ToolContext): Promise<ActiveProjectContext> {
  try {
    const session = await ctx.store.getSession();
    if (!session || typeof session !== "object") return {};
    const projectId = boundedProjectId((session as { activeProjectId?: unknown }).activeProjectId);
    if (!projectId) return {};

    let registry: ProjectRegistryEntry[] = ctx.registry;
    if (registry.length === 0) {
      registry = await ctx.store.loadProjects();
    }
    const project = registry.find((entry) => entry.projectId === projectId);
    return project ? { projectId, projectRoot: project.root } : { projectId };
  } catch {
    // Tool hooks are observational. Broken session/registry state must not
    // change the underlying tool result or throw through the MCP boundary.
    return {};
  }
}

async function emitToolHook(
  ctx: ToolContext,
  event: "PreToolUse" | "PostToolUse",
  toolName: string,
  payload: Record<string, unknown>,
  active: ActiveProjectContext,
): Promise<void> {
  try {
    const report = await getHookEngine(ctx).emit(
      event,
      payload,
      {
        workspaceRoot: ctx.workspaceRoot,
        ...(active.projectRoot ? { projectRoot: active.projectRoot } : {}),
      },
    );
    await auditHookDispatch(ctx, report);
  } catch {
    await auditHookUnexpectedError(ctx, event, toolName);
  }
}

/**
 * Install M4.3 tool lifecycle hooks at the shared MCP registered-tool
 * boundary. Call this only after every Core/agent/worker tool has been
 * registered so one wrapper covers the complete tool surface.
 *
 * Hook payloads intentionally exclude raw tool arguments/results. They carry
 * only bounded tool/project identity plus PostToolUse success/duration.
 * Hook failures never veto, replace, or otherwise alter the original tool
 * result/error.
 */
export function installToolLifecycleHooks(server: McpServer, ctx: ToolContext): void {
  const registeredTools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  if (!registeredTools) return;

  for (const [toolName, tool] of Object.entries(registeredTools)) {
    const original = tool.handler;
    if (!original) continue;

    tool.handler = async (...args: unknown[]) => {
      const requested = requestedProjectId(args);
      const before = await readActiveProjectContext(ctx);
      await emitToolHook(
        ctx,
        "PreToolUse",
        toolName,
        {
          toolName,
          remote: ctx.remote === true,
          hasActiveProject: before.projectId !== undefined,
          ...(before.projectId ? { activeProjectId: before.projectId } : {}),
          ...(requested ? { requestedProjectId: requested } : {}),
        },
        before,
      );

      const startedAt = Date.now();
      try {
        const result = await original(...args);
        const after = await readActiveProjectContext(ctx);
        await emitToolHook(
          ctx,
          "PostToolUse",
          toolName,
          {
            toolName,
            remote: ctx.remote === true,
            hasActiveProject: after.projectId !== undefined,
            ...(after.projectId ? { activeProjectId: after.projectId } : {}),
            ...(requested ? { requestedProjectId: requested } : {}),
            success: result?.isError !== true,
            durationMs: Date.now() - startedAt,
          },
          after,
        );
        return result;
      } catch (error) {
        const after = await readActiveProjectContext(ctx);
        await emitToolHook(
          ctx,
          "PostToolUse",
          toolName,
          {
            toolName,
            remote: ctx.remote === true,
            hasActiveProject: after.projectId !== undefined,
            ...(after.projectId ? { activeProjectId: after.projectId } : {}),
            ...(requested ? { requestedProjectId: requested } : {}),
            success: false,
            durationMs: Date.now() - startedAt,
          },
          after,
        );
        throw error;
      }
    };
  }
}
