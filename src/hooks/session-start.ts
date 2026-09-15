import type { ProjectRegistryEntry, ToolContext } from "../types.js";
import { HookEngine, type HookDispatchReport } from "./engine.js";

interface SessionLike {
  activeProjectId?: unknown;
}

function activeProjectIdFromSession(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const activeProjectId = (value as SessionLike).activeProjectId;
  return typeof activeProjectId === "string" && activeProjectId.trim() ? activeProjectId : undefined;
}

function projectForId(registry: ProjectRegistryEntry[], projectId: string | undefined): ProjectRegistryEntry | undefined {
  if (!projectId) return undefined;
  return registry.find((entry) => entry.projectId === projectId);
}

async function readActiveProjectId(ctx: ToolContext): Promise<string | undefined> {
  try {
    return activeProjectIdFromSession(await ctx.store.getSession());
  } catch {
    // SessionStart is observational/best-effort. A corrupt/unavailable persisted
    // session must not prevent a fresh MCP server instance from being created.
    return undefined;
  }
}

async function auditDispatch(ctx: ToolContext, report: HookDispatchReport): Promise<void> {
  const failed = report.results.filter((result) => result.status === "failed").length;
  const timedOut = report.results.filter((result) => result.status === "timed_out").length;
  try {
    await ctx.ledger.append({
      type: "hook.dispatch",
      event: report.event,
      configured: report.configured,
      executed: report.executed,
      failed,
      timedOut,
      configError: report.configError !== undefined,
      durationMs: report.durationMs,
    });
  } catch {
    // Hook observability is never allowed to make MCP session creation fail.
  }
}

/**
 * Emit the M4 SessionStart lifecycle event for one freshly-created MCP server
 * instance. HTTP creates one MCP server per initialize/session; stdio creates
 * one server for its single transport, so this is exactly-once at the MCP
 * session/server boundary without inventing transport-specific hook paths.
 *
 * The payload intentionally contains only bounded identity/state metadata.
 * Filesystem paths are supplied separately as HookEmitContext so they can be
 * used for the configured cwd mode without being copied into the event body.
 */
export async function emitSessionStartHook(ctx: ToolContext): Promise<HookDispatchReport> {
  const activeProjectId = await readActiveProjectId(ctx);
  const activeProject = projectForId(ctx.registry, activeProjectId);
  const engine = new HookEngine(ctx.stateDir);
  const report = await engine.emit(
    "SessionStart",
    {
      transport: ctx.remote === true ? "http" : "stdio",
      remote: ctx.remote === true,
      hasActiveProject: activeProject !== undefined,
      ...(activeProject ? { activeProjectId: activeProject.projectId } : {}),
    },
    {
      workspaceRoot: ctx.workspaceRoot,
      ...(activeProject ? { projectRoot: activeProject.root } : {}),
    },
  );
  await auditDispatch(ctx, report);
  return report;
}
