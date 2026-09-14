import { DomainError, ErrorCode } from "../types.js";
import { issueWorkerCapability, revokeWorkerCapability } from "./capability.js";
import {
  BrowserWorkerController,
  type BrowserWorkerDriver,
  type BrowserWorkerSession,
} from "./browser-controller.js";
import { getWorker, markWorkerRunning, type WorkerRecord } from "./store.js";

export interface BrowserWorkerLaunchOutcome {
  worker: WorkerRecord;
  browser: BrowserWorkerSession;
  capabilityExpiresAt: number;
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

  const capability = await issueWorkerCapability(stateDir, workerId, capabilityTtlMs);
  const controller = new BrowserWorkerController(stateDir, driver);
  let browser: BrowserWorkerSession | undefined;
  try {
    browser = await controller.launch({
      workerId,
      projectId: worker.projectId,
      task: worker.task,
      workerToken: capability.token,
    });
    const running = await markWorkerRunning(stateDir, workerId);
    return {
      worker: running,
      browser,
      capabilityExpiresAt: capability.expiresAt,
    };
  } catch (error) {
    await revokeWorkerCapability(stateDir, workerId).catch(() => undefined);
    if (browser?.status === "running") {
      await controller.cancel(workerId).catch(() => undefined);
    }
    throw error;
  }
}
