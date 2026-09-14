import { promises as fs } from "node:fs";
import { DomainError, ErrorCode, makeResult, type ToolContext, type ToolResult } from "../types.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { resolveActiveProject } from "../workspace/active.js";
import { redact } from "../policy/secrets.js";
import { assertAllowedTarget, controlAllowlist, isAppAllowed, isControlChatGptExposed } from "./policy.js";
import { assertScreenshotTargetAllowed, maskSensitiveRegions } from "./screenshot-mask.js";
import { captureControlAppScreenshot, captureControlScreenScreenshot } from "./capture.js";
import { executeApprovedAction } from "./executor.js";
import * as desktopInput from "./input-backend.js";
import * as macInput from "./mac-input.js";
import {
  approveAction,
  enqueue,
  getAction,
  isKilled,
  listActions,
  rejectAction,
  setKill,
  toSummary,
  type ControlActionKind,
  type ControlActionTarget,
  type ResolvedTargetPreview,
} from "./queue.js";

/**
 * Handlers for the 4 Option B desktop-control MCP tools. Registered
 * conditionally by src/server/tools.ts (only when isControlEnabled()), and
 * kept intentionally free of any dependency on src/server/tools.ts /
 * src/server/actions.ts to avoid a module cycle — both of those import
 * *from* here, never the reverse.
 */

interface CallToolResultLike {
  content: ToolResult["content"];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

function redactControlInput(input: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(input)));
  } catch {
    return undefined;
  }
}

// Success-path structuredContent already goes through toSummary()/redact()
// (e.g. computer_action_status text summary). The error path must too: a
// raw thrown error message (or its `details`) can otherwise reach both the
// permanent ledger `error` field and the untrusted-model-facing tool result
// unredacted — mirrors src/server/tools.ts mapError, which has the
// identical DomainError/non-DomainError branches redact()ed. redactControlInput
// already JSON-round-trips through redact(), so it doubles as the `details`
// redactor here.
function mapControlError(err: unknown): ToolResult<{ error: string; code: string; details?: unknown }> {
  if (err instanceof DomainError) {
    const safeMessage = redact(err.message);
    return makeResult(
      { error: safeMessage, code: err.code, details: redactControlInput(err.details) },
      `Error [${err.code}]: ${safeMessage}`,
      true,
    );
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redact(rawMessage);
  return makeResult({ error: message, code: ErrorCode.NOT_IMPLEMENTED }, `Error: ${message}`, true);
}

async function withControlErrorMapping<T extends Record<string, unknown>>(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  fn: () => Promise<ToolResult<T> | CallToolResultLike>,
): Promise<CallToolResultLike> {
  try {
    const result = await fn();
    await ctx.ledger.append({
      type: "tool.call.completed",
      tool: toolName,
      input: redactControlInput(input),
      isError: result.isError === true,
    });
    return { content: result.content, structuredContent: result.structuredContent, ...(result.isError ? { isError: true } : {}) };
  } catch (err) {
    const mapped = mapControlError(err);
    await ctx.ledger.append({
      type: "tool.call.failed",
      tool: toolName,
      input: redactControlInput(input),
      code: mapped.structuredContent.code,
      error: mapped.structuredContent.error,
    });
    return { content: mapped.content, structuredContent: mapped.structuredContent, isError: true };
  }
}

/** Both gates: an active project must hold a `control`-capable lease. */
async function requireControlLease(ctx: ToolContext): Promise<{ projectId: string; root: string }> {
  const active = await resolveActiveProject(ctx);
  if (!active) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Select a project with project_select preset=control first");
  }
  await requireProjectLease(ctx, active.projectId, "control");
  return { projectId: active.projectId, root: active.root };
}

export interface ComputerScreenshotInput {
  appName?: string;
  label?: string;
  waitMs?: number;
}

export async function handleComputerScreenshot(ctx: ToolContext, input: ComputerScreenshotInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_screenshot", input, async () => {
    const { projectId, root } = await requireControlLease(ctx);
    // A full-screen capture shows whatever is visible, so the sensitive-app
    // gate checks the live frontmost app where the platform can report it.
    // Windows ChatGPT-exposed mode still refuses full-screen capture entirely
    // below; M3 adds only explicit app-window capture there.
    const frontmostApp =
      input.appName === undefined && (process.platform === "darwin" || process.platform === "win32")
        ? await desktopInput.resolveFrontmostApp().catch(() => undefined)
        : undefined;
    assertScreenshotTargetAllowed(input.appName, frontmostApp);

    // Screenshot capture must pass the same allowlist gate as synthetic
    // input (click/type/key): the denylist check above only refuses known
    // sensitive apps, it does not require the target to be explicitly
    // opted in. Without this, any non-denylisted, non-allowlisted app could
    // be captured even though it could never be clicked/typed into.
    const allowlist = controlAllowlist();
    if (input.appName !== undefined) {
      if (!isAppAllowed(input.appName, allowlist)) {
        throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `App is not on the control allowlist: ${input.appName}`, {
          appName: input.appName,
        });
      }
    } else if (isControlChatGptExposed()) {
      // Full-screen capture can include background sensitive windows. The
      // remotely reachable mode therefore requires an explicit allowlisted
      // appName and captures only that selected window.
      throw new DomainError(
        ErrorCode.SENSITIVE_TARGET_BLOCKED,
        "Full-screen capture is not available when exposed to ChatGPT (it can show background sensitive windows the allowlist can't see); pass an allowlisted appName to capture a specific window",
        { appName: frontmostApp },
      );
    }

    const result = input.appName
      ? await captureControlAppScreenshot(root, { appName: input.appName, label: input.label, waitMs: input.waitMs })
      : await captureControlScreenScreenshot(root, { label: input.label, waitMs: input.waitMs });
    const masked = await maskSensitiveRegions({ pngPath: result.path, appName: input.appName });

    await ctx.ledger.append({
      type: "control.screenshot.captured",
      projectId,
      appName: input.appName ?? "screen",
      masked: masked.masked,
      captureMethod: result.captureMethod,
      dpi: result.dpi,
    });

    const base64 = await fs.readFile(masked.pngPath).then((buf) => buf.toString("base64"));
    return {
      structuredContent: {
        path: masked.pngPath,
        bytes: result.bytes,
        appName: input.appName ?? null,
        ...(result.captureMethod ? { captureMethod: result.captureMethod } : {}),
        ...(result.dpi ? { dpi: result.dpi, scaleFactor: result.scaleFactor } : {}),
      },
      content: [
        { type: "text", text: `Captured control screenshot: ${masked.pngPath}` },
        { type: "image", data: base64, mimeType: "image/png" },
      ],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerRequestActionInput {
  appName: string;
  kind: ControlActionKind;
  target: ControlActionTarget;
  text?: string;
  keyCode?: number;
  reason: string;
}

// Defense in depth for the ChatGPT-exposed immediate-execution branch below:
// the server has no way to verify that a client's Confirm/Deny prompt was a
// distinct, deliberate human tap rather than an "always allow"/auto-approve
// client setting or a prompt-injected loop re-issuing the same request. This
// bounds how many approvedVia:"chatgpt" actions can auto-execute inside a
// rolling window; once the cap is hit, further requests fall back to the
// normal queue+local-approval path below (never hard-fail the request), so a
// runaway burst surfaces to the local operator instead of continuing to run
// unattended.
const CHATGPT_EXPOSED_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const CHATGPT_EXPOSED_RATE_LIMIT_MAX = 20;

async function isChatGptExposedRateLimited(stateDir: string, now = Date.now()): Promise<boolean> {
  const actions = await listActions(stateDir);
  const recentAutoExecuted = actions.filter(
    (a) =>
      a.approvedVia === "chatgpt" &&
      a.result?.executedAt !== undefined &&
      now - a.result.executedAt < CHATGPT_EXPOSED_RATE_LIMIT_WINDOW_MS,
  );
  return recentAutoExecuted.length >= CHATGPT_EXPOSED_RATE_LIMIT_MAX;
}

export async function handleComputerRequestAction(ctx: ToolContext, input: ComputerRequestActionInput): Promise<CallToolResultLike> {
  const redactedInput = { ...input, text: input.text ? "[redacted]" : undefined };
  return withControlErrorMapping(ctx, "computer_request_action", redactedInput, async () => {
    const { projectId } = await requireControlLease(ctx);

    if (await isKilled(ctx.stateDir)) {
      throw new DomainError(ErrorCode.CONTROL_KILLED, "Control session is killed; grant a new control lease to resume");
    }

    const frontmostApp =
      process.platform === "darwin" || process.platform === "win32"
        ? await desktopInput.resolveFrontmostApp().catch(() => undefined)
        : undefined;
    try {
      assertAllowedTarget({ appName: input.appName, frontmostAppName: frontmostApp, allowlist: controlAllowlist() });
    } catch (err) {
      await ctx.ledger.append({
        type: "control.action.blocked",
        projectId,
        appName: input.appName,
        frontmostApp,
        reason: err instanceof DomainError ? err.code : "blocked",
      });
      throw err;
    }

    // Dry-run preview: resolve the AX target read-only (no activate/click) so
    // the local approver can see role/title/frame/app/window/matchCount
    // before anything executes. Windows semantic targeting arrives in M3.3.
    let resolved: ResolvedTargetPreview | undefined;
    if (input.target.ax && process.platform === "darwin") {
      resolved = await macInput.resolveAxElement(input.appName, input.target.ax).catch((err) => ({
        found: false,
        reason: err instanceof Error ? err.message : String(err),
      }));
    }

    const record = await enqueue(ctx.stateDir, {
      appName: input.appName,
      kind: input.kind,
      target: input.target,
      text: input.text,
      keyCode: input.keyCode,
      reason: input.reason,
      resolved,
    });

    await ctx.ledger.append({
      type: "control.action.requested",
      projectId,
      actionId: record.actionId,
      appName: record.appName,
      kind: record.kind,
      target: record.target,
      reason: record.reason,
      resolved: record.resolved,
    });

    if (isControlChatGptExposed() && !(await isChatGptExposedRateLimited(ctx.stateDir))) {
      // Reaching this call means the owner's client already showed its
      // Confirm/Deny prompt. Execute through the same shared executor path.
      const approved = await approveAction(ctx.stateDir, record.actionId, { approvedVia: "chatgpt" });
      await executeApprovedAction(ctx, approved);
      const done = (await getAction(ctx.stateDir, record.actionId)) ?? approved;
      const summary = toSummary(done);
      const errorSuffix = done.result?.ok === false && done.result.error ? `, error=${done.result.error}` : "";
      return {
        structuredContent: { ...summary },
        content: [
          {
            type: "text",
            text: `Control action ${done.actionId} was confirmed and executed (status=${done.status}${errorSuffix}).`,
          },
        ],
      } satisfies CallToolResultLike;
    }

    if (isControlChatGptExposed()) {
      await ctx.ledger.append({
        type: "control.action.rate_limited",
        projectId,
        actionId: record.actionId,
        appName: record.appName,
      });
    }

    const summary = toSummary(record);
    return {
      structuredContent: { ...summary },
      content: [
        {
          type: "text",
          text: `Control action ${record.actionId} is queued and requires local human approval before it executes (status=${record.status}).`,
        },
      ],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerActionStatusInput {
  actionId?: string;
}

export async function handleComputerActionStatus(ctx: ToolContext, input: ComputerActionStatusInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_action_status", input, async () => {
    await requireControlLease(ctx);

    if (input.actionId) {
      const record = await getAction(ctx.stateDir, input.actionId);
      if (!record) {
        throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Control action not found: ${input.actionId}`);
      }
      const summary = toSummary(record);
      return {
        structuredContent: { action: summary },
        content: [{ type: "text", text: `Action ${record.actionId}: ${record.status}` }],
      } satisfies CallToolResultLike;
    }

    const actions = (await listActions(ctx.stateDir)).map(toSummary);
    return {
      structuredContent: { actions },
      content: [{ type: "text", text: `${actions.length} control action(s) in the queue.` }],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerKillSwitchInput {
  reason?: string;
}

export async function handleComputerKillSwitch(ctx: ToolContext, input: ComputerKillSwitchInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_kill_switch", input, async () => {
    const { projectId } = await requireControlLease(ctx);
    await setKill(ctx.stateDir);
    await ctx.ledger.append({ type: "control.kill", projectId, reason: input.reason });
    return {
      structuredContent: { killed: true },
      content: [{ type: "text", text: "Control session killed. All pending actions were rejected." }],
    } satisfies CallToolResultLike;
  });
}

// approveAction/rejectAction/CLI helpers are re-exported from queue.ts by
// src/cli.ts directly; nothing else in this module needs them.
export { approveAction, rejectAction };
