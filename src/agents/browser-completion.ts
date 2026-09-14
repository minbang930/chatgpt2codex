import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verifyWorkerCapability } from "./capability.js";
import {
  BrowserWorkerController,
  getBrowserWorkerSession,
  type BrowserWorkerDriver,
} from "./browser-controller.js";
import { createChromeCdpBrowserWorkerDriver } from "./chrome-cdp.js";

interface CallToolResultLike {
  isError?: boolean;
  [key: string]: unknown;
}

interface RegisteredToolLike {
  handler?: (...args: unknown[]) => Promise<CallToolResultLike>;
}

function tokenFromArgs(args: unknown[]): string | undefined {
  const input = args[0];
  if (!input || typeof input !== "object") return undefined;
  const token = (input as { workerToken?: unknown }).workerToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * Wrap `worker_finish` so a successfully completed durable worker retires its
 * browser tab. Completion/result persistence remains authoritative: browser
 * cleanup is best-effort and can never turn a successful `worker_finish` into
 * an error. Browser-controller state records a close failure for later
 * recovery/diagnostics.
 */
export function installWorkerCompletionBrowserCleanup(
  server: McpServer,
  stateDir: string,
  driver: BrowserWorkerDriver = createChromeCdpBrowserWorkerDriver(stateDir),
): void {
  const registeredTools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  const tool = registeredTools?.worker_finish;
  const original = tool?.handler;
  if (!tool || !original) return;

  tool.handler = async (...args: unknown[]) => {
    const token = tokenFromArgs(args);
    const capability = token
      ? await verifyWorkerCapability(stateDir, token).catch(() => null)
      : null;

    const result = await original(...args);
    if (result.isError === true || !capability) return result;

    try {
      const browser = await getBrowserWorkerSession(stateDir, capability.workerId);
      if (!browser || browser.status === "stopped" || browser.status === "failed") return result;
      const controller = new BrowserWorkerController(stateDir, driver);
      await controller.cancel(capability.workerId);
    } catch {
      // Durable worker completion already succeeded. Browser cleanup failure is
      // intentionally non-fatal; BrowserWorkerController records it when able.
    }
    return result;
  };
}
