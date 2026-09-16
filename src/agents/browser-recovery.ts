import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { revokeWorkerCapability } from "./capability.js";
import {
  getBrowserWorkerSession,
  markBrowserWorkerFailed,
  type BrowserWorkerSession,
} from "./browser-controller.js";
import { getWorker, type WorkerRecord, type WorkerStatus } from "./store.js";

const FALLBACK_COMPLETION_PREFIX = "ChatGPT worker response ended without worker_finish.";
const MAX_FALLBACK_ASSISTANT_TEXT = 2_800;

export interface BrowserTargetProbe {
  isAlive(browserHandle: string | undefined): Promise<boolean>;
}

export type BrowserCompletionState = "generating" | "idle" | "unknown";

export interface BrowserCompletionObservation {
  state: BrowserCompletionState;
  assistantText?: string;
}

/**
 * Optional, read-only browser inspection used only after target liveness is
 * confirmed. `idle` means ChatGPT appears to have stopped generating and a
 * stable assistant response is visible. It is never treated as a successful
 * coding-worker result; `worker_finish` remains the only primary completion
 * handshake.
 */
export interface BrowserCompletionProbe {
  inspect(browserHandle: string | undefined): Promise<BrowserCompletionObservation>;
}

interface CallToolResultLike {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RegisteredToolLike {
  handler?: (...args: unknown[]) => Promise<CallToolResultLike>;
}

function isFallbackCompletion(session: BrowserWorkerSession): boolean {
  return session.lastError?.startsWith(FALLBACK_COMPLETION_PREFIX) === true;
}

function browserView(session: BrowserWorkerSession, durableStatus: WorkerStatus | undefined): Record<string, unknown> {
  return {
    status: session.status,
    attempt: session.attempt,
    route: session.route.mode,
    browserHandle: session.browserHandle,
    lastError: session.lastError,
    recoverable:
      durableStatus === "running" && (session.status === "failed" || session.status === "stopped"),
    completionFallback: isFallbackCompletion(session),
  };
}

function executionView(
  worker: WorkerRecord | null,
  browser: BrowserWorkerSession | null,
): Record<string, unknown> | undefined {
  const intent = worker?.executionIntent;
  const observed = browser?.execution;
  if (!intent && !observed) return undefined;
  const observedSettings = observed && (observed.observedModel || observed.observedReasoningEffort)
    ? {
        model: observed.observedModel,
        reasoningEffort: observed.observedReasoningEffort,
      }
    : undefined;
  return {
    requested: intent?.requested,
    resolved: intent?.resolved,
    sources: intent?.sources,
    observed: observedSettings,
    verified: observed?.verified,
    error: observed?.error,
    attempt: browser?.attempt,
  };
}

function fallbackFailureMessage(assistantText: string): string {
  const normalized = assistantText.trim().slice(0, MAX_FALLBACK_ASSISTANT_TEXT);
  return [
    FALLBACK_COMPLETION_PREFIX,
    "The durable worker is intentionally still running and its worktree is preserved.",
    "Last assistant response (diagnostic only, not a durable worker result):",
    normalized,
    "Call agent_launch to recover the same worker in a fresh ChatGPT tab.",
  ].join("\n");
}

/**
 * Check only a running browser session. Losing the local tab invalidates its
 * worker capability and marks browser state failed, but deliberately leaves
 * the durable coding worker/result/worktree untouched so it can be recovered.
 *
 * If the tab is alive, an optional completion probe may detect the fallback
 * case where ChatGPT has become idle with a stable assistant response but the
 * worker never called `worker_finish`. That path is also made recoverable; it
 * never fabricates a completed durable worker result from DOM text.
 */
export async function reconcileBrowserWorker(
  stateDir: string,
  workerId: string,
  probe: BrowserTargetProbe,
  completionProbe?: BrowserCompletionProbe,
): Promise<BrowserWorkerSession | null> {
  const current = await getBrowserWorkerSession(stateDir, workerId);
  if (!current || current.status !== "running") return current;

  let alive = false;
  try {
    alive = await probe.isAlive(current.browserHandle);
  } catch {
    alive = false;
  }
  if (!alive) {
    await revokeWorkerCapability(stateDir, workerId).catch(() => undefined);
    return markBrowserWorkerFailed(
      stateDir,
      workerId,
      "Browser worker target is no longer available. Call agent_launch to recover this worker in a fresh ChatGPT tab.",
    );
  }

  if (!completionProbe) return current;
  const worker = await getWorker(stateDir, workerId);
  if (!worker || worker.status !== "running") return current;

  let completion: BrowserCompletionObservation;
  try {
    completion = await completionProbe.inspect(current.browserHandle);
  } catch {
    // DOM inspection is deliberately best-effort. A selector/UI change must
    // not degrade a healthy worker into a failed one.
    return current;
  }
  const assistantText = completion.assistantText?.trim();
  if (completion.state !== "idle" || !assistantText) return current;

  await revokeWorkerCapability(stateDir, workerId).catch(() => undefined);
  return markBrowserWorkerFailed(stateDir, workerId, fallbackFailureMessage(assistantText));
}

function withExecutionDiagnostics(
  result: CallToolResultLike,
  worker: WorkerRecord | null,
  browser: BrowserWorkerSession | null,
): CallToolResultLike {
  const execution = executionView(worker, browser);
  if (!execution) return result;
  return {
    ...result,
    structuredContent: {
      ...(result.structuredContent ?? {}),
      execution,
    },
  };
}

/**
 * Enrich `agent_status` with reconciled browser state and both `agent_status`
 * and `agent_result` with durable-vs-observed execution diagnostics. Liveness
 * is reconciled only on status reads; result reads stay durable/read-only.
 */
export function installAgentStatusBrowserReconciliation(
  server: McpServer,
  stateDir: string,
  probe: BrowserTargetProbe,
  completionProbe?: BrowserCompletionProbe,
): void {
  const registered = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  const statusTool = registered?.agent_status;
  const originalStatus = statusTool?.handler;
  if (statusTool && originalStatus) {
    statusTool.handler = async (...args: unknown[]) => {
      const input = args[0] as { workerId?: unknown } | undefined;
      const workerId = typeof input?.workerId === "string" ? input.workerId : undefined;
      let browser: BrowserWorkerSession | null = null;
      if (workerId) {
        browser = await reconcileBrowserWorker(stateDir, workerId, probe, completionProbe).catch(() => null);
      }

      const result = await originalStatus(...args);
      const durableWorker = workerId ? await getWorker(stateDir, workerId).catch(() => null) : null;
      let enriched = withExecutionDiagnostics(result, durableWorker, browser);
      if (!browser) return enriched;
      const fallback = isFallbackCompletion(browser);
      enriched = {
        ...enriched,
        structuredContent: {
          ...(enriched.structuredContent ?? {}),
          browser: browserView(browser, durableWorker?.status),
        },
      };
      return fallback
        ? {
            ...enriched,
            content: [
              ...(Array.isArray(enriched.content) ? enriched.content : []),
              {
                type: "text",
                text: `Browser fallback detected for ${workerId}: ${browser.lastError ?? FALLBACK_COMPLETION_PREFIX}`,
              },
            ],
          }
        : enriched;
    };
  }

  const resultTool = registered?.agent_result;
  const originalResult = resultTool?.handler;
  if (resultTool && originalResult) {
    resultTool.handler = async (...args: unknown[]) => {
      const input = args[0] as { workerId?: unknown } | undefined;
      const workerId = typeof input?.workerId === "string" ? input.workerId : undefined;
      const result = await originalResult(...args);
      if (!workerId) return result;
      const [worker, browser] = await Promise.all([
        getWorker(stateDir, workerId).catch(() => null),
        getBrowserWorkerSession(stateDir, workerId).catch(() => null),
      ]);
      return withExecutionDiagnostics(result, worker, browser);
    };
  }
}
