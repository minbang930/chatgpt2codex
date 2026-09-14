import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { getWorker } from "./store.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const WORKER_ID_RE = /^wrk_[0-9a-fA-F-]{36}$/;
const TOKEN_RE = /^wcap\.(wrk_[0-9a-fA-F-]{36})\.([A-Za-z0-9_-]{32,})$/;

export interface WorkerCapabilityRecord {
  version: 1;
  workerId: string;
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface IssuedWorkerCapability {
  workerId: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

const CapabilitySchema = z.object({
  version: z.literal(1),
  workerId: z.string().regex(WORKER_ID_RE),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<WorkerCapabilityRecord>;

function capabilitiesDir(stateDir: string): string {
  return path.join(stateDir, "agents", "capabilities");
}

function capabilityPath(stateDir: string, workerId: string): string {
  if (!WORKER_ID_RE.test(workerId) || path.basename(workerId) !== workerId) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Invalid worker capability identity");
  }
  return path.join(capabilitiesDir(stateDir), `${workerId}.json`);
}

async function ensureCapabilitiesDir(stateDir: string): Promise<void> {
  const dir = capabilitiesDir(stateDir);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // Filesystems without POSIX permission bits are still supported.
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function writeCapability(stateDir: string, record: WorkerCapabilityRecord): Promise<void> {
  const validated = CapabilitySchema.parse(record);
  await ensureCapabilitiesDir(stateDir);
  const target = capabilityPath(stateDir, validated.workerId);
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  try {
    await fs.chmod(temp, FILE_MODE);
  } catch {
    // Non-fatal.
  }
  await fs.rename(temp, target);
}

async function readCapability(stateDir: string, workerId: string): Promise<WorkerCapabilityRecord | null> {
  let file: string;
  try {
    file = capabilityPath(stateDir, workerId);
  } catch {
    return null;
  }
  try {
    const parsed = CapabilitySchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function normalizeTtl(ttlMs: number | undefined): number {
  const value = ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TTL_MS) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Worker capability TTL must be between 1 and ${MAX_TTL_MS} ms`);
  }
  return Math.floor(value);
}

/**
 * Issue a new bearer capability for one non-final worker. Reissuing replaces
 * the previous capability record, immediately invalidating the old token.
 * Only the SHA-256 digest is persisted; the raw token is returned once.
 */
export async function issueWorkerCapability(
  stateDir: string,
  workerId: string,
  ttlMs?: number,
): Promise<IssuedWorkerCapability> {
  const worker = await getWorker(stateDir, workerId);
  if (!worker) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Worker not found: ${workerId}`);
  }
  if (worker.status === "completed" || worker.status === "failed" || worker.status === "cancelled") {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Cannot issue a capability for ${worker.status} worker ${workerId}`);
  }
  if (!worker.workspace || worker.workspace.removedAt !== undefined) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Worker workspace is not available: ${workerId}`);
  }

  const now = Date.now();
  const expiresAt = now + normalizeTtl(ttlMs);
  const token = `wcap.${workerId}.${randomBytes(32).toString("base64url")}`;
  await writeCapability(stateDir, {
    version: 1,
    workerId,
    tokenHash: hashToken(token),
    issuedAt: now,
    expiresAt,
  });
  return { workerId, token, issuedAt: now, expiresAt };
}

/** Resolve and authenticate a worker capability without trusting browser identity. */
export async function verifyWorkerCapability(
  stateDir: string,
  token: string,
): Promise<{ workerId: string; expiresAt: number }> {
  const match = TOKEN_RE.exec(token);
  if (!match) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Invalid worker capability");
  }
  const workerId = match[1]!;
  const record = await readCapability(stateDir, workerId);
  if (!record || record.revokedAt !== undefined || Date.now() > record.expiresAt) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Worker capability is expired, revoked, or unknown");
  }

  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(record.tokenHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Worker capability does not match the active token");
  }

  const worker = await getWorker(stateDir, workerId);
  if (!worker || worker.status === "completed" || worker.status === "failed" || worker.status === "cancelled") {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Worker capability is no longer active");
  }
  if (!worker.workspace || worker.workspace.removedAt !== undefined) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Worker workspace is not available");
  }

  return { workerId, expiresAt: record.expiresAt };
}

/** Revoke the currently active capability for a worker, if one exists. */
export async function revokeWorkerCapability(stateDir: string, workerId: string): Promise<boolean> {
  const record = await readCapability(stateDir, workerId);
  if (!record) return false;
  if (record.revokedAt !== undefined) return true;
  await writeCapability(stateDir, { ...record, revokedAt: Date.now() });
  return true;
}
