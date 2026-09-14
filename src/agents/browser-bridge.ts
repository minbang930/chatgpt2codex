import { randomBytes } from "node:crypto";
import { DomainError, ErrorCode } from "../types.js";
import type { BrowserWorkerRoute } from "./browser-controller.js";

const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 5 * 60_000;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 2 * 60_000;
const TICKET_RE = /^bwt_[A-Za-z0-9_-]{32,}$/;

export interface BrowserLaunchPayload {
  workerId: string;
  projectId: string;
  task: string;
  workerToken: string;
  route: BrowserWorkerRoute;
}

export type BrowserLaunchAcknowledgement =
  | {
      status: "launched";
      browserHandle: string;
      fallbackUsed?: boolean;
    }
  | {
      status: "failed";
      error: string;
    };

export interface IssuedBrowserLaunchTicket {
  ticket: string;
  expiresAt: number;
}

interface BrowserLaunchRecord {
  expiresAt: number;
  payload?: BrowserLaunchPayload;
  claimedAt?: number;
  acknowledgement?: BrowserLaunchAcknowledgement;
  waiters: Set<(acknowledgement: BrowserLaunchAcknowledgement) => void>;
}

export interface BrowserLaunchBrokerOptions {
  now?: () => number;
}

function normalizeDuration(value: number | undefined, fallback: number, max: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0 || duration > max) {
    throw new DomainError(ErrorCode.TIMEOUT, `${label} must be between 1 and ${max} ms`);
  }
  return Math.floor(duration);
}

function normalizePayload(payload: BrowserLaunchPayload): BrowserLaunchPayload {
  const workerId = payload.workerId.trim();
  const projectId = payload.projectId.trim();
  const task = payload.task.trim();
  const workerToken = payload.workerToken.trim();
  if (!workerId || !projectId || !task || !workerToken) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Browser launch payload fields must not be empty");
  }
  return {
    workerId,
    projectId,
    task,
    workerToken,
    route: payload.route,
  };
}

function normalizeAcknowledgement(ack: BrowserLaunchAcknowledgement): BrowserLaunchAcknowledgement {
  if (ack.status === "launched") {
    const browserHandle = ack.browserHandle.trim();
    if (!browserHandle || browserHandle.length > 512) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Browser launch acknowledgement requires a valid browser handle");
    }
    return {
      status: "launched",
      browserHandle,
      ...(ack.fallbackUsed === true ? { fallbackUsed: true } : {}),
    };
  }

  const error = ack.error.trim();
  if (!error || error.length > 4000) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Browser launch failure acknowledgement requires an error message");
  }
  return { status: "failed", error };
}

function sameAcknowledgement(a: BrowserLaunchAcknowledgement, b: BrowserLaunchAcknowledgement): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "launched" && b.status === "launched") {
    return a.browserHandle === b.browserHandle && Boolean(a.fallbackUsed) === Boolean(b.fallbackUsed);
  }
  return a.status === "failed" && b.status === "failed" && a.error === b.error;
}

/**
 * In-memory, one-time handoff between the local runtime and a future browser
 * worker extension/controller. The raw worker capability and task exist only
 * until the ticket is claimed; they are never written to disk and are erased
 * from the broker immediately after a successful claim.
 */
export class BrowserLaunchBroker {
  private readonly records = new Map<string, BrowserLaunchRecord>();
  private readonly now: () => number;

  constructor(options: BrowserLaunchBrokerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  issue(payload: BrowserLaunchPayload, ttlMs?: number): IssuedBrowserLaunchTicket {
    const normalized = normalizePayload(payload);
    const ttl = normalizeDuration(ttlMs, DEFAULT_TTL_MS, MAX_TTL_MS, "Browser launch ticket TTL");
    const ticket = `bwt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + ttl;
    this.records.set(ticket, {
      expiresAt,
      payload: normalized,
      waiters: new Set(),
    });
    return { ticket, expiresAt };
  }

  private requireRecord(ticket: string): BrowserLaunchRecord {
    if (!TICKET_RE.test(ticket)) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Invalid browser launch ticket");
    }
    const record = this.records.get(ticket);
    if (!record) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Browser launch ticket is unknown");
    }
    if (this.now() > record.expiresAt) {
      this.deleteRecord(ticket, record);
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Browser launch ticket expired");
    }
    return record;
  }

  claim(ticket: string): BrowserLaunchPayload {
    const record = this.requireRecord(ticket);
    if (record.claimedAt !== undefined || !record.payload) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Browser launch ticket was already claimed");
    }
    const payload = record.payload;
    record.payload = undefined;
    record.claimedAt = this.now();
    return payload;
  }

  acknowledge(ticket: string, acknowledgement: BrowserLaunchAcknowledgement): BrowserLaunchAcknowledgement {
    const record = this.requireRecord(ticket);
    if (record.claimedAt === undefined) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Browser launch ticket must be claimed before acknowledgement");
    }
    const normalized = normalizeAcknowledgement(acknowledgement);
    if (record.acknowledgement) {
      if (sameAcknowledgement(record.acknowledgement, normalized)) return record.acknowledgement;
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Browser launch ticket already has a different acknowledgement");
    }
    record.acknowledgement = normalized;
    for (const resolve of record.waiters) resolve(normalized);
    record.waiters.clear();
    return normalized;
  }

  async waitForAcknowledgement(ticket: string, timeoutMs?: number): Promise<BrowserLaunchAcknowledgement> {
    const waitMs = normalizeDuration(timeoutMs, DEFAULT_WAIT_MS, MAX_WAIT_MS, "Browser launch acknowledgement wait");
    const record = this.requireRecord(ticket);
    if (record.acknowledgement) return record.acknowledgement;

    const remainingTtl = Math.max(1, record.expiresAt - this.now());
    const effectiveWait = Math.min(waitMs, remainingTtl);
    return new Promise<BrowserLaunchAcknowledgement>((resolve, reject) => {
      let settled = false;
      const onAck = (ack: BrowserLaunchAcknowledgement) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(onAck);
        resolve(ack);
      };
      record.waiters.add(onAck);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        record.waiters.delete(onAck);
        reject(new DomainError(ErrorCode.TIMEOUT, "Timed out waiting for browser launch acknowledgement"));
      }, effectiveWait);
    });
  }

  cancel(ticket: string): boolean {
    const record = this.records.get(ticket);
    if (!record) return false;
    this.deleteRecord(ticket, record);
    return true;
  }

  private deleteRecord(ticket: string, record: BrowserLaunchRecord): void {
    this.records.delete(ticket);
    record.payload = undefined;
    record.waiters.clear();
  }
}
