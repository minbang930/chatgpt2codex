import type { ToolContext } from "../types.js";
import { HookEngine, type HookDispatchReport } from "./engine.js";

const engines = new WeakMap<ToolContext, HookEngine>();

/** Keep exactly one HookEngine instance per ToolContext. HTTP creates a fresh
 * remote ToolContext per initialized MCP session; stdio keeps one context for
 * its single server instance. */
export function getHookEngine(ctx: ToolContext): HookEngine {
  let engine = engines.get(ctx);
  if (!engine) {
    engine = new HookEngine(ctx.stateDir);
    engines.set(ctx, engine);
  }
  return engine;
}

/** Persist only a bounded dispatch summary. Hook stdout/stderr and event
 * payloads are deliberately not copied into the audit ledger. */
export async function auditHookDispatch(ctx: ToolContext, report: HookDispatchReport): Promise<void> {
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
    // Hook observability is best-effort and must never affect Core behavior.
  }
}

export async function auditHookUnexpectedError(
  ctx: ToolContext,
  event: string,
  toolName?: string,
): Promise<void> {
  try {
    await ctx.ledger.append({
      type: "hook.dispatch.unexpected_error",
      event,
      ...(toolName ? { tool: toolName } : {}),
    });
  } catch {
    // Same failure-isolation rule as normal hook dispatch auditing.
  }
}
