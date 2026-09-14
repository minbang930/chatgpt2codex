import { setTimeout as delay } from "node:timers/promises";
import { DomainError, ErrorCode, type ProjectRegistryEntry } from "../types.js";
import {
  cancelWorker,
  getWorker,
  listUnnotifiedWorkerEvents,
  markWorkerEventNotified,
  type WorkerNotification,
  type WorkerRecord,
  type WorkerResult,
} from "./store.js";
import { provisionWorkerWorktree, verifyWorkerWorktree } from "./worktree.js";

const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 100;

export interface AgentSpawnInput {
  project: Pick<ProjectRegistryEntry, "projectId" | "root">;
  task: string;
  baseRef?: string;
}

export interface AgentWaitInput {
  workerIds?: string[];
  timeoutMs?: number;
}

export interface AgentEvent {
  worker: WorkerRecord;
  notification: WorkerNotification;
}

export interface AgentWaitResult {
  timedOut: boolean;
  events: AgentEvent[];
}

async function requireWorker(stateDir: string, workerId: string): Promise<WorkerRecord> {
  const worker = await getWorker(stateDir, workerId);
  if (!worker) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Worker not found: ${workerId}`);
  }
  return worker;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_WAIT_MS;
  if (!Number.isFinite(value) || value < 0 || value > MAX_WAIT_MS) {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `Agent wait timeout must be between 0 and ${MAX_WAIT_MS} ms`,
    );
  }
  return Math.floor(value);
}

function selectEvents(events: AgentEvent[], workerIds: Set<string> | null): AgentEvent[] {
  if (!workerIds) return events;
  return events.filter((event) => workerIds.has(event.worker.workerId));
}

/**
 * Create a durable worker and provision its isolated Git branch/worktree.
 *
 * This deliberately leaves the worker in `pending`: M2's browser worker
 * controller owns the transition to `running` once a real ChatGPT worker has
 * accepted the task. If provisioning fails, the pending worker record is kept
 * so a retry can recover an already-created managed worktree without deleting
 * uncertain work.
 */
export async function spawnAgent(stateDir: string, input: AgentSpawnInput): Promise<WorkerRecord> {
  const { createWorker } = await import("./store.js");
  const worker = await createWorker(stateDir, {
    projectId: input.project.projectId,
    task: input.task,
  });

  try {
    return await provisionWorkerWorktree(
      stateDir,
      input.project.root,
      worker.workerId,
      input.baseRef ?? "HEAD",
    );
  } catch (err) {
    if (err instanceof DomainError) {
      throw new DomainError(err.code, err.message, {
        ...(err.details ?? {}),
        workerId: worker.workerId,
      });
    }
    throw err;
  }
}

/** Read the durable worker record without mutating it. */
export async function getAgentStatus(stateDir: string, workerId: string): Promise<WorkerRecord> {
  return requireWorker(stateDir, workerId);
}

/**
 * Return a worker's final payload while keeping status/error visible for
 * failed or cancelled workers. Running/pending workers simply have no result.
 */
export async function getAgentResult(
  stateDir: string,
  workerId: string,
): Promise<{
  workerId: string;
  status: WorkerRecord["status"];
  result?: WorkerResult;
  error?: string;
}> {
  const worker = await requireWorker(stateDir, workerId);
  return {
    workerId: worker.workerId,
    status: worker.status,
    result: worker.result,
    error: worker.error,
  };
}

/**
 * Mark a worker cancelled. Its worktree/branch are intentionally preserved;
 * cleanup is a separate explicit operation so cancellation cannot destroy
 * partial worker edits.
 */
export async function cancelAgent(
  stateDir: string,
  workerId: string,
  reason = "cancelled",
): Promise<WorkerRecord> {
  await requireWorker(stateDir, workerId);
  return cancelWorker(stateDir, workerId, reason);
}

/**
 * Verify that a worker still owns the managed worktree recorded in durable
 * state. This is the boundary future worker tool routing can call before any
 * worker-scoped file/shell/git operation.
 */
export async function getAgentWorkspace(
  stateDir: string,
  projectRoot: string,
  workerId: string,
): Promise<{ worktreePath: string; branch: string; head: string }> {
  const worker = await requireWorker(stateDir, workerId);
  return verifyWorkerWorktree(stateDir, projectRoot, worker);
}

/**
 * Short-poll the durable inbox until at least one unnotified final worker event
 * exists or the timeout expires. This does not acknowledge events: the caller
 * must do that only after it successfully delivers the notice to ChatGPT.
 */
export async function waitForAgentEvents(
  stateDir: string,
  input: AgentWaitInput = {},
): Promise<AgentWaitResult> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const workerIds = input.workerIds ? new Set(input.workerIds) : null;

  if (workerIds) {
    for (const workerId of workerIds) {
      await requireWorker(stateDir, workerId);
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const events = selectEvents(await listUnnotifiedWorkerEvents(stateDir), workerIds);
    if (events.length > 0) {
      return { timedOut: false, events };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { timedOut: true, events: [] };
    }
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/** Mark one durable completion notification as delivered. */
export async function acknowledgeAgentEvent(
  stateDir: string,
  eventId: string,
): Promise<WorkerRecord> {
  const worker = await markWorkerEventNotified(stateDir, eventId);
  if (!worker) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Worker event not found: ${eventId}`);
  }
  return worker;
}
