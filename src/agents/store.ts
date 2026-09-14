import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const WORKER_ID_RE = /^wrk_[0-9a-fA-F-]{36}$/;
const EVENT_ID_RE = /^evt_[0-9a-fA-F-]{36}$/;

export type WorkerStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type WorkerFinalStatus = Extract<WorkerStatus, "completed" | "failed" | "cancelled">;

export interface WorkerResult {
  summary: string;
  commitSha?: string;
  changedFiles?: string[];
  checks?: string[];
  remainingIssues?: string[];
}

export interface WorkerNotification {
  eventId: string;
  status: WorkerFinalStatus;
  createdAt: number;
  notifiedAt?: number;
}

export interface WorkerRecord {
  workerId: string;
  projectId: string;
  task: string;
  status: WorkerStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: WorkerResult;
  error?: string;
  notification?: WorkerNotification;
}

const WorkerResultSchema = z.object({
  summary: z.string(),
  commitSha: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  checks: z.array(z.string()).optional(),
  remainingIssues: z.array(z.string()).optional(),
});

const WorkerNotificationSchema = z.object({
  eventId: z.string().regex(EVENT_ID_RE),
  status: z.enum(["completed", "failed", "cancelled"]),
  createdAt: z.number().int().nonnegative(),
  notifiedAt: z.number().int().nonnegative().optional(),
});

const WorkerRecordSchema = z.object({
  workerId: z.string().regex(WORKER_ID_RE),
  projectId: z.string().min(1),
  task: z.string().min(1),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
  result: WorkerResultSchema.optional(),
  error: z.string().optional(),
  notification: WorkerNotificationSchema.optional(),
}) satisfies z.ZodType<WorkerRecord>;

function agentsDir(stateDir: string): string {
  return path.join(stateDir, "agents");
}

function workersDir(stateDir: string): string {
  return path.join(agentsDir(stateDir), "workers");
}

function isValidWorkerId(workerId: string): boolean {
  return WORKER_ID_RE.test(workerId) && workerId === path.basename(workerId);
}

function isValidEventId(eventId: string): boolean {
  return EVENT_ID_RE.test(eventId) && eventId === path.basename(eventId);
}

function workerPath(stateDir: string, workerId: string): string {
  if (!isValidWorkerId(workerId)) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Invalid worker id: ${workerId}`);
  }
  return path.join(workersDir(stateDir), `${workerId}.json`);
}

async function ensureWorkersDir(stateDir: string): Promise<void> {
  const dir = workersDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(agentsDir(stateDir), DIR_MODE);
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // Non-fatal on filesystems without POSIX permission bits.
  }
}

async function writeWorker(stateDir: string, record: WorkerRecord): Promise<void> {
  const validated = WorkerRecordSchema.parse(record);
  await ensureWorkersDir(stateDir);
  const target = workerPath(stateDir, validated.workerId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  try {
    await fs.chmod(temp, FILE_MODE);
  } catch {
    // Non-fatal on filesystems without POSIX permission bits.
  }
  await fs.rename(temp, target);
}

async function requireWorker(stateDir: string, workerId: string): Promise<WorkerRecord> {
  const worker = await getWorker(stateDir, workerId);
  if (!worker) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Worker not found: ${workerId}`);
  }
  return worker;
}

function isFinalStatus(status: WorkerStatus): status is WorkerFinalStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function makeNotification(status: WorkerFinalStatus, now: number): WorkerNotification {
  return {
    eventId: `evt_${randomUUID()}`,
    status,
    createdAt: now,
  };
}

async function finalizeWorker(
  stateDir: string,
  workerId: string,
  status: WorkerFinalStatus,
  patch: Pick<WorkerRecord, "result" | "error">,
): Promise<WorkerRecord> {
  const current = await requireWorker(stateDir, workerId);
  if (isFinalStatus(current.status)) {
    if (current.status === status) return current;
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `Worker ${workerId} is already ${current.status}; cannot transition to ${status}`,
    );
  }

  const now = Date.now();
  const next: WorkerRecord = {
    ...current,
    ...patch,
    status,
    updatedAt: now,
    finishedAt: now,
    notification: makeNotification(status, now),
  };
  await writeWorker(stateDir, next);
  return next;
}

export async function createWorker(
  stateDir: string,
  input: { projectId: string; task: string },
): Promise<WorkerRecord> {
  const projectId = input.projectId.trim();
  const task = input.task.trim();
  if (!projectId) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Worker projectId must not be empty");
  }
  if (!task) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Worker task must not be empty");
  }

  const now = Date.now();
  const record: WorkerRecord = {
    workerId: `wrk_${randomUUID()}`,
    projectId,
    task,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await writeWorker(stateDir, record);
  return record;
}

export async function getWorker(stateDir: string, workerId: string): Promise<WorkerRecord | null> {
  let file: string;
  try {
    file = workerPath(stateDir, workerId);
  } catch {
    return null;
  }
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = WorkerRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function listWorkers(stateDir: string): Promise<WorkerRecord[]> {
  const dir = workersDir(stateDir);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const workers: WorkerRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const workerId = file.slice(0, -5);
    const worker = await getWorker(stateDir, workerId);
    if (worker) workers.push(worker);
  }
  return workers.sort((a, b) => a.createdAt - b.createdAt);
}

export async function markWorkerRunning(stateDir: string, workerId: string): Promise<WorkerRecord> {
  const current = await requireWorker(stateDir, workerId);
  if (current.status === "running") return current;
  if (isFinalStatus(current.status)) {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `Worker ${workerId} is already ${current.status}; cannot mark it running`,
    );
  }
  const now = Date.now();
  const next: WorkerRecord = {
    ...current,
    status: "running",
    startedAt: current.startedAt ?? now,
    updatedAt: now,
  };
  await writeWorker(stateDir, next);
  return next;
}

export async function completeWorker(
  stateDir: string,
  workerId: string,
  result: WorkerResult,
): Promise<WorkerRecord> {
  if (!result.summary.trim()) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Worker completion summary must not be empty");
  }
  return finalizeWorker(stateDir, workerId, "completed", { result, error: undefined });
}

export async function failWorker(stateDir: string, workerId: string, error: string): Promise<WorkerRecord> {
  const message = error.trim();
  if (!message) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Worker failure reason must not be empty");
  }
  return finalizeWorker(stateDir, workerId, "failed", { result: undefined, error: message });
}

export async function cancelWorker(
  stateDir: string,
  workerId: string,
  reason = "cancelled",
): Promise<WorkerRecord> {
  return finalizeWorker(stateDir, workerId, "cancelled", {
    result: undefined,
    error: reason.trim() || "cancelled",
  });
}

export async function listUnnotifiedWorkerEvents(stateDir: string): Promise<Array<{ worker: WorkerRecord; notification: WorkerNotification }>> {
  const workers = await listWorkers(stateDir);
  return workers
    .filter(
      (worker): worker is WorkerRecord & { notification: WorkerNotification } =>
        worker.notification !== undefined && worker.notification.notifiedAt === undefined,
    )
    .map((worker) => ({ worker, notification: worker.notification }));
}

export async function markWorkerEventNotified(
  stateDir: string,
  eventId: string,
  notifiedAt = Date.now(),
): Promise<WorkerRecord | null> {
  if (!isValidEventId(eventId)) return null;
  const workers = await listWorkers(stateDir);
  const worker = workers.find((item) => item.notification?.eventId === eventId);
  if (!worker?.notification) return null;
  if (worker.notification.notifiedAt !== undefined) return worker;

  const next: WorkerRecord = {
    ...worker,
    updatedAt: Math.max(worker.updatedAt, notifiedAt),
    notification: {
      ...worker.notification,
      notifiedAt,
    },
  };
  await writeWorker(stateDir, next);
  return next;
}
