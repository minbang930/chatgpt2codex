import { DomainError, ErrorCode } from "../types.js";
import { loadActivatedSkillContext } from "../skills/activation.js";
import { issueWorkerCapability, revokeWorkerCapability } from "./capability.js";
import {
  BrowserWorkerController,
  getBrowserWorkerSession,
  type BrowserWorkerDriver,
  type BrowserWorkerSession,
} from "./browser-controller.js";
import { applyPonytailToWorkerTask } from "./ponytail.js";
import { getWorker, markWorkerRunning, type WorkerRecord } from "./store.js";

export interface BrowserWorkerLaunchOutcome {
  worker: WorkerRecord;
  browser: BrowserWorkerSession;
  capabilityExpiresAt: number;
}

async function workerSkillContext(stateDir: string, worker: WorkerRecord): Promise<string | undefined> {
  try {
    const activated = await loadActivatedSkillContext({
      stateDir,
      projectId: worker.projectId,
    });
    const warnings = activated.skipped.length > 0
      ? [
        "Activated Agent Skill notes:",
        ...activated.skipped.map((item) => `- ${item.name}: ${item.reason}`),
      ].join("\n")
      : "";
    const combined = [activated.text, warnings].filter(Boolean).join("\n\n").trim();
    return combined || undefined;
  } catch {
    // Skills are an instruction-layer extension. Corrupt/missing optional skill
    // activation state must not prevent an otherwise healthy durable worker
    // from launching with its original task and existing capability boundary.
    return undefined;
  }
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
    const ponytailTask = applyPonytailToWorkerTask(worker.task);
    const skillContext = await workerSkillContext(stateDir, worker);
    const launchTask = skillContext
      ? [ponytailTask, "", "Additional activated Agent Skill instructions:", skillContext].join("\n")
      : ponytailTask;
    browser = await controller.launch({
      workerId: worker.workerId,
      projectId: worker.projectId,
      task: launchTask,
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

async function discardLaunchedBrowser(
  stateDir: string,
  driver: BrowserWorkerDriver,
  workerId: string,
  browser: BrowserWorkerSession,
): Promise<void> {
  await revokeWorkerCapability(stateDir, workerId).catch(() => undefined);
  if (browser.status === "running") {
    const controller = new BrowserWorkerController(stateDir, driver);
    await controller.cancel(workerId).catch(() => undefined);
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
  try {
    const running = await markWorkerRunning(stateDir, workerId);
    return {
      worker: running,
      browser: launched.browser,
      capabilityExpiresAt: launched.capabilityExpiresAt,
    };
  } catch (error) {
    await discardLaunchedBrowser(stateDir, driver, workerId, launched.browser);
    throw error;
  }
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
