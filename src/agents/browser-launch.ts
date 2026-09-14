import { DomainError, ErrorCode } from "../types.js";
import { issueWorkerCapability, revokeWorkerCapability } from "./capability.js";
import {
  BrowserWorkerController,
  getBrowserWorkerSession,
  type BrowserWorkerDriver,
  type BrowserWorkerSession,
} from "./browser-controller.js";
import { getWorker, markWorkerRunning, type WorkerRecord } from "./store.js";

export interface BrowserWorkerLaunchOutcome {
  worker: WorkerRecord;
  browser: BrowserWorkerSession;
  capabilityExpiresAt: number;
}

async function launchWorkerBrowser(
  stateDir: string,
  driver: BrowserWorkerDriver,
  worker: WorkerRecord,
  capabilityTtlMs?: number,
): Promise<{ browser: BrowserWorkerSession; capabilityExpiresAt: number }> {
  const capability = await issueWorkerCapability(stateDir, worker.workerId, capabilityTtlMs);
  const controller = new BrowserWorkerController(stateDir, driver);
  let browser: BrowserWorkerSession | undefined;
  try {
    browser = await controller.launch({
      workerId: worker.workerId,
      projectId: worker.projectId,
      task: worker.task,
      workerToken: capability.token,
    });
    return { browser, capabilityExpiresAt: capability.expiresAt };
  } catch (error) {
    await revokeWorkerCapability(stateDir, worker.workerId).catch(() => undefined);
    if (browser?.status === "running") {
      await controller.cancel(worker.workerId).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Launch one already-prepared durable worker into ChatGPT Web. The capability
 * is issued immediately before launch and is never returned to the parent
 * model; only the browser driver receives the raw token. The durable worker
 * becomes `running` only after the driver confirms that the bootstrap prompt
 * was submitted successfully.
 */
export async function launchPreparedBrowserWorker(
  stateDir: string,
  driver: BrowserWorkerDriver,
  workerId: string,
  capabilityTtlMs?: number,
): Promise<BrowserWorkerLaunchOutcome> {
  const worker = await getWorker(stateDir, workerId);
  if (!worker) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Worker not found: ${workerId}`);
  }
  if (worker.status !== "pending") {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker ${workerId} must be pending before browser launch; current status is ${worker.status}`,
    );
  }
  if (!worker.workspace || worker.workspace.removedAt !== undefined) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Worker workspace is not available: ${workerId}`);
  }

  const launched = await launchWorkerBrowser(stateDir, driver, worker, capabilityTtlMs);
  const running = await markWorkerRunning(stateDir, workerId);
  return {
    worker: running,
    browser: launched.browser,
    capabilityExpiresAt: launched.capabilityExpiresAt,
  };
}

/**
 * Reattach a durable `running` worker whose previous browser target was lost.
 * The Git worktree and worker identity are reused, while a fresh capability and
 * browser attempt are created. Recovery is allowed only after browser state is
 * final (`failed`/`stopped`) so it cannot duplicate a live worker tab.
 */
export async function recoverRunningBrowserWorker(
  stateDir: string,
  driver: BrowserWorkerDriver,
  workerId: string,
  capabilityTtlMs?: number,
): Promise<BrowserWorkerLaunchOutcome> {
  const worker = await getWorker(stateDir, workerId);
  if (!worker) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Worker not found: ${workerId}`);
  }
  if (worker.status !== "running") {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker ${workerId} must be running for browser recovery; current status is ${worker.status}`,
    );
  }
  if (!worker.workspace || worker.workspace.removedAt !== undefined) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Worker workspace is not available: ${workerId}`);
  }

  const previous = await getBrowserWorkerSession(stateDir, workerId);
  if (!previous || (previous.status !== "failed" && previous.status !== "stopped")) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker ${workerId} browser must be failed or stopped before recovery`,
    );
  }

  await revokeWorkerCapability(stateDir, workerId).catch(() => undefined);
  const launched = await launchWorkerBrowser(stateDir, driver, worker, capabilityTtlMs);
  return {
    worker,
    browser: launched.browser,
    capabilityExpiresAt: launched.capabilityExpiresAt,
  };
}
