import type { ToolContext } from "../types.js";
import { resolveActiveProject } from "../workspace/active.js";
import { HookEngine, type HookDispatchReport } from "./engine.js";

export type SessionStartTransport = "stdio" | "http";

const engines = new WeakMap<ToolContext, HookEngine>();

/** Keep one HookEngine instance per ToolContext without widening the shared
 * ToolContext contract. HTTP creates a fresh remote ToolContext per MCP
 * session, while stdio keeps one context for its single server instance. */
export function getHookEngine(ctx: ToolContext): HookEngine {
  let engine = engines.get(ctx);
  if (!engine) {
    engine = new HookEngine(ctx.stateDir);
    engines.set(ctx, engine);
  }
  return engine;
}

async function appendHookAudit(
  ctx: ToolContext,
  event: { type: string; [key: string]: unknown },
): Promise<void> {
  try {
    await ctx.ledger.append(event);
  } catch {
    // Hook observability is best-effort and must never affect Core startup.
  }
}

/**
 * Emit the M4.2 SessionStart lifecycle notification after an MCP server
 * instance is connected to its transport.
 *
 * The payload is intentionally metadata-only: transport kind, remote/local
 * status, active project id, and current lease preset. Filesystem paths are
 * used only as local hook cwd context and are not copied into the event
 * payload. Any active-project lookup, hook-config, hook-process, or audit
 * failure is isolated from MCP startup.
 */
export async function emitSessionStart(
  ctx: ToolContext,
  transport: SessionStartTransport,
): Promise<HookDispatchReport | undefined> {
  try {
    let active: Awaited<ReturnType<typeof resolveActiveProject>> = null;
    try {
      active = await resolveActiveProject(ctx);
    } catch (error) {
      await appendHookAudit(ctx, {
        type: "hook.session_start.project_context_unavailable",
        transport,
        remote: ctx.remote === true,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const report = await getHookEngine(ctx).emit(
      "SessionStart",
      {
        transport,
        remote: ctx.remote === true,
        activeProjectId: active?.projectId ?? null,
        leasePreset: active?.lease?.preset ?? null,
      },
      {
        workspaceRoot: ctx.workspaceRoot,
        ...(active?.root ? { projectRoot: active.root } : {}),
      },
    );

    await appendHookAudit(ctx, {
      type: "hook.session_start",
      transport,
      remote: ctx.remote === true,
      activeProjectId: active?.projectId ?? null,
      configured: report.configured,
      executed: report.executed,
      failed: report.results.filter((result) => result.status !== "ok").length,
      configError: report.configError ?? null,
      durationMs: report.durationMs,
    });

    return report;
  } catch (error) {
    await appendHookAudit(ctx, {
      type: "hook.session_start.unexpected_error",
      transport,
      remote: ctx.remote === true,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
