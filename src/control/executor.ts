import type { ToolContext } from "../types.js";
import { resolveActiveProject } from "../workspace/active.js";
import { redact } from "../policy/secrets.js";
import { captureControlAppScreenshot } from "./capture.js";
import { assertAllowedTarget, controlAllowlist, isSensitiveApp } from "./policy.js";
import { maskSensitiveRegions } from "./screenshot-mask.js";
import { autoDecision, recordAutoUse } from "./auto.js";
import { approveAction, getAction, isKilled, listActions, markDone, toSummary, type ControlActionRecord } from "./queue.js";
import * as desktopInput from "./input-backend.js";

/**
 * Session worker that turns an `approved` control action into a real
 * synthetic click/keystroke. Platform-specific actuation is isolated behind
 * src/control/input-backend.ts; every action still passes this shared queue,
 * kill-switch, allowlist, evidence, and audit path before input is emitted.
 */

function keySummary(keyCode: number | undefined): string | undefined {
  return keyCode === undefined ? undefined : `keyCode:${keyCode}`;
}

/** Clamp a windowPoint xRel/yRel to [0,1]. The HTTP action bridge
 * (src/server/actions.ts callRegisteredTool) can reach handleComputerRequestAction
 * without the tool's zod schema (min(0).max(1)) ever running, so a queued
 * record's windowPoint is not guaranteed to be in range by the time it is
 * executed here — re-validate at the actual synthetic-input call site
 * rather than trusting the stored value. */
function clampUnitInterval(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The public keyCode contract keeps the original macOS virtual-key-code
 * namespace (0..127). Windows translates supported values to Win32 VK codes
 * inside win-input.ts instead of reinterpreting the number. */
function isValidKeyCode(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 127;
}

/** Best-effort before/after app-window screenshot evidence for an approved
 * action. Never throws and never blocks execution. Sensitive targets are
 * skipped entirely and the capture remains anchored under the active project.
 * Windows uses the same explicit app-window capture path as computer_screenshot;
 * unrestricted full-screen fallback is intentionally not used there. */
async function captureActionEvidence(
  ctx: ToolContext,
  record: ControlActionRecord,
  phase: "before" | "after",
): Promise<{ path: string; masked: boolean } | undefined> {
  if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
  if (isSensitiveApp(record.appName)) return undefined;
  try {
    const active = await resolveActiveProject(ctx);
    if (!active) return undefined;
    const label = `control-${record.actionId}-${phase}`;
    const captured = await captureControlAppScreenshot(active.root, { appName: record.appName, label, waitMs: 0 });
    const masked = await maskSensitiveRegions({ pngPath: captured.path, appName: record.appName });
    return { path: masked.pngPath, masked: masked.masked };
  } catch {
    return undefined;
  }
}

/**
 * Turn one `approved` action into a real synthetic click/keystroke: re-checks
 * kill state, macOS Accessibility preflight where applicable, and the live
 * frontmost sensitive-app/allowlist gate before doing anything. It always
 * ends by marking the record `done` and never throws to the executor loop.
 */
export async function executeApprovedAction(ctx: ToolContext, record: ControlActionRecord): Promise<void> {
  if (await isKilled(ctx.stateDir)) {
    await ctx.ledger.append({
      type: "control.action.blocked",
      actionId: record.actionId,
      appName: record.appName,
      reason: "killed",
    });
    await markDone(ctx.stateDir, record.actionId, { ok: false, error: "killed" });
    return;
  }

  // macOS has a definitive Accessibility preflight in the signed AX helper.
  // Windows SendInput has no equivalent TCC grant, so the shared executor
  // proceeds directly to the live target/allowlist check there.
  if (process.platform === "darwin") {
    const preflight = await desktopInput.preflightPermissions().catch(() => undefined);
    if (preflight && preflight.source === "ax-helper" && !preflight.accessibilityTrusted) {
      await ctx.ledger.append({
        type: "control.action.blocked",
        actionId: record.actionId,
        appName: record.appName,
        reason: "accessibility-permission-required",
      });
      await markDone(ctx.stateDir, record.actionId, { ok: false, error: "accessibility-permission-required" });
      return;
    }
  }

  const frontmostApp = await desktopInput.resolveFrontmostApp().catch(() => undefined);
  try {
    assertAllowedTarget({ appName: record.appName, frontmostAppName: frontmostApp, allowlist: controlAllowlist() });
  } catch (err) {
    await ctx.ledger.append({
      type: "control.action.blocked",
      actionId: record.actionId,
      appName: record.appName,
      frontmostApp,
      reason: err instanceof Error ? err.message : String(err),
    });
    await markDone(ctx.stateDir, record.actionId, { ok: false, error: "blocked" });
    return;
  }

  const evidenceBefore = await captureActionEvidence(ctx, record, "before");
  try {
    let axSummary: Record<string, unknown> | undefined;
    let windowPoint: { x: number; y: number } | undefined;

    if (record.kind === "click") {
      if (record.target.ax) {
        // Semantic targets are re-resolved immediately before actuation on
        // platforms that support them. M3.1 Windows deliberately reports
        // semantic targeting unsupported and falls back only when the action
        // also carries an explicit windowPoint.
        try {
          await desktopInput.pressAxElement(record.appName, record.target.ax);
          axSummary = { ...record.target.ax };
        } catch (err) {
          if (!record.target.windowPoint) throw err;
          const resolved = await desktopInput.resolveWindowPoint(
            record.appName,
            clampUnitInterval(record.target.windowPoint.xRel),
            clampUnitInterval(record.target.windowPoint.yRel),
          );
          await desktopInput.clickAtPoint(record.appName, resolved.x, resolved.y);
          windowPoint = resolved;
        }
      } else if (record.target.windowPoint) {
        const resolved = await desktopInput.resolveWindowPoint(
          record.appName,
          clampUnitInterval(record.target.windowPoint.xRel),
          clampUnitInterval(record.target.windowPoint.yRel),
        );
        await desktopInput.clickAtPoint(record.appName, resolved.x, resolved.y);
        windowPoint = resolved;
      } else {
        throw new Error("click action has neither an ax nor a windowPoint target");
      }
    } else if (record.kind === "type") {
      if (record.target.ax) {
        try {
          await desktopInput.setAxValue(record.appName, record.target.ax, record.text ?? "");
          axSummary = { ...record.target.ax };
        } catch (err) {
          if (!record.target.windowPoint) throw err;
          const resolved = await desktopInput.resolveWindowPoint(
            record.appName,
            clampUnitInterval(record.target.windowPoint.xRel),
            clampUnitInterval(record.target.windowPoint.yRel),
          );
          await desktopInput.clickAtPoint(record.appName, resolved.x, resolved.y);
          await desktopInput.typeText(record.appName, record.text ?? "");
          windowPoint = resolved;
        }
      } else {
        await desktopInput.typeText(record.appName, record.text ?? "");
      }
    } else if (record.kind === "key") {
      const keyCode = record.keyCode ?? 0;
      if (!isValidKeyCode(keyCode)) {
        throw new Error("key action has an out-of-range keyCode");
      }
      await desktopInput.pressKey(record.appName, keyCode);
    }

    const evidenceAfter = await captureActionEvidence(ctx, record, "after");
    const evidence = { before: evidenceBefore?.path, after: evidenceAfter?.path };
    await ctx.ledger.append({
      type: "control.action.executed",
      actionId: record.actionId,
      appName: record.appName,
      kind: record.kind,
      axSummary,
      windowPoint,
      keySummary: keySummary(record.keyCode),
      textSummary: toSummary(record).textSummary,
      evidence,
      approvedVia: record.approvedVia ?? "human",
      ok: true,
    });
    await markDone(ctx.stateDir, record.actionId, { ok: true, evidence });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Text-carrying actions never persist raw OS/helper errors: even though
    // text is sent to both native backends over stdin/environment rather than
    // argv, keep the fixed reason code as defense in depth.
    const message = record.kind === "type" ? "type-failed" : redact(rawMessage);
    const evidenceAfter = await captureActionEvidence(ctx, record, "after");
    const evidence = { before: evidenceBefore?.path, after: evidenceAfter?.path };
    await ctx.ledger.append({
      type: "control.action.executed",
      actionId: record.actionId,
      appName: record.appName,
      kind: record.kind,
      evidence,
      approvedVia: record.approvedVia ?? "human",
      ok: false,
      error: message,
    });
    await markDone(ctx.stateDir, record.actionId, { ok: false, error: message, evidence });
  }
}

/**
 * Promote any `pending` action that falls inside the local operator's
 * bounded auto-approve scope (src/control/auto.ts) straight to `approved`,
 * exactly like a human clicking Approve would, tagged `approvedVia:"auto"`
 * for the audit trail. autoDecision() itself re-checks the sensitive-app
 * denylist, the control allowlist, TTL, kind filter, and max-count on every
 * call, so this never widens what an action is allowed to target — it only
 * decides *who* clicked Approve. The promoted action still has to pass
 * executeApprovedAction's own preflight/frontmost/assertAllowedTarget/kill
 * checks below before any real synthetic input happens.
 */
async function autoApprovePendingActions(ctx: ToolContext): Promise<void> {
  const actions = await listActions(ctx.stateDir);
  for (const summary of actions) {
    if (summary.status !== "pending") continue;
    if (await isKilled(ctx.stateDir)) return;
    const fresh = await getAction(ctx.stateDir, summary.actionId);
    if (!fresh || fresh.status !== "pending") continue;

    const decision = await autoDecision(ctx.stateDir, { appName: fresh.appName, kind: fresh.kind });
    if (!decision.allowed) continue;

    let promoted: ControlActionRecord;
    try {
      promoted = await approveAction(ctx.stateDir, fresh.actionId, { approvedVia: "auto" });
    } catch {
      // Lost a race (e.g. killed or already moved between the checks
      // above and here) — leave it for the next pass / a human.
      continue;
    }
    await recordAutoUse(ctx.stateDir);
    await ctx.ledger.append({
      type: "control.action.auto_approved",
      actionId: promoted.actionId,
      appName: promoted.appName,
      kind: promoted.kind,
      scopeExpiresAt: decision.scope?.expiresAt,
    });
  }
}

/** Process every currently-approved action once (after first auto-approving
 * any in-scope pending ones). Exported separately from startExecutor so
 * tests can drive the worker deterministically instead of waiting on a
 * timer. */
export async function runExecutorOnce(ctx: ToolContext): Promise<void> {
  if (await isKilled(ctx.stateDir)) return;
  await autoApprovePendingActions(ctx);
  if (await isKilled(ctx.stateDir)) return;
  const actions = await listActions(ctx.stateDir);
  for (const summary of actions) {
    if (summary.status !== "approved") continue;
    if (await isKilled(ctx.stateDir)) return;
    const fresh = await getAction(ctx.stateDir, summary.actionId);
    if (!fresh || fresh.status !== "approved") continue;
    await executeApprovedAction(ctx, fresh);
  }
}

/** Start the in-process polling worker. Returns a stop function. Safe to
 * call once per server process; the returned interval is unref'd so it
 * never keeps the process alive on its own. */
export function startExecutor(ctx: ToolContext, intervalMs = 1000): () => void {
  const timer = setInterval(() => {
    runExecutorOnce(ctx).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
