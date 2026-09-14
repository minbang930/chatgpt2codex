import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { revokeWorkerCapability } from "./capability.js";
import {
  getBrowserWorkerSession,
  markBrowserWorkerFailed,
  type BrowserWorkerSession,
} from "./browser-controller.js";

export interface BrowserTargetProbe {
  isAlive(browserHandle: string | undefined): Promise<boolean>;
}

interface CallToolResultLike {
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RegisteredToolLike {
  handler?: (...args: unknown[]) => Promise<CallToolResultLike>;
}

function browserView(session: BrowserWorkerSession): Record<string, unknown> {
  return {
    status: session.status,
    attempt: session.attempt,
    route: session.route.mode,
    browserHandle: session.browserHandle,
    lastError: session.lastError,
    recoverable: session.status === "failed" || session.status === "stopped",
  };
}

/**
 * Check only a running browser session. Losing the local tab invalidates its
 * worker capability and marks browser state failed, but deliberately leaves
 * the durable coding worker/result/worktree untouched so it can be recovered.
 */
export async function reconcileBrowserWorker(
  stateDir: string,
  workerId: string,
  probe: BrowserTargetProbe,
): Promise<BrowserWorkerSession | null> {
  const current = await getBrowserWorkerSession(stateDir, workerId);
  if (!current || current.status !== "running") return current;

  let alive = false;
  try {
    alive = await probe.isAlive(current.browserHandle);
  } catch {
    alive = false;
  }
  if (alive) return current;

  await revokeWorkerCapability(stateDir, workerId).catch(() => undefined);
  return markBrowserWorkerFailed(
    stateDir,
    workerId,
    "Browser worker target is no longer available. Call agent_launch to recover this worker in a fresh ChatGPT tab.",
  );
}

/**
 * Enrich the existing `agent_status` result with reconciled browser state.
 * Liveness is checked on demand rather than by a background poller, keeping
 * Core operation independent from browser health.
 */
export function installAgentStatusBrowserReconciliation(
  server: McpServer,
  stateDir: string,
  probe: BrowserTargetProbe,
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
      browser = await reconcileBrowserWorker(stateDir, workerId, probe).catch(() => null);
    }

    const result = await original(...args);
    if (!browser) return result;
    return {
      ...result,
      structuredContent: {
        ...(result.structuredContent ?? {}),
        browser: browserView(browser),
      },
    };
  };
}
