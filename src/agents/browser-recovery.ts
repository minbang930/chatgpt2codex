import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { revokeWorkerCapability } from "./capability.js";
import {
  getBrowserWorkerSession,
  markBrowserWorkerFailed,
  type BrowserWorkerSession,
} from "./browser-controller.js";
import { getWorker, type WorkerStatus } from "./store.js";

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

/**
 * Enrich the existing `agent_status` result with reconciled browser state.
 * Liveness/completion are checked on demand rather than by a background
 * poller, keeping Core operation independent from browser health.
 */
export function installAgentStatusBrowserReconciliation(
  server: McpServer,
  stateDir: string,
  probe: BrowserTargetProbe,
  completionProbe?: BrowserCompletionProbe,
): void {
  const registered = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  const tool = registered?.agent_status;
  const original = tool?.handler;
  if (!tool || !original) return;

  tool.handler = async (...args: unknown[]) => {
    const input = args[0] as { workerId?: unknown } | undefined;
    const workerId = typeof input?.workerId === "string" ? input.workerId : undefined;
    let browser: BrowserWorkerSession | null = null;
    if (workerId) {
      browser = await reconcileBrowserWorker(stateDir, workerId, probe, completionProbe).catch(() => null);
    }

    const result = await original(...args);
    if (!browser) return result;
    const durableWorker = workerId ? await getWorker(stateDir, workerId).catch(() => null) : null;
    const fallback = isFallbackCompletion(browser);
    return {
      ...result,
      structuredContent: {
        ...(result.structuredContent ?? {}),
        browser: browserView(browser, durableWorker?.status),
      },
      content: fallback
        ? [
            ...(Array.isArray(result.content) ? result.content : []),
            {
              type: "text",
              text: `Browser fallback detected for ${workerId}: ${browser.lastError ?? FALLBACK_COMPLETION_PREFIX}`,
            },
          ]
        : result.content,
    };
  };
}
