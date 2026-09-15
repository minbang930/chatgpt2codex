import { DomainError, ErrorCode } from "../types.js";

const DEFAULT_CANCEL_LATCH_MS = 4_000;

let generation = 0;
let lastCancelledAt = 0;
let lastReason = "escape";
let cancelLatchMs = DEFAULT_CANCEL_LATCH_MS;
const waiters = new Set<() => void>();

function cancelledError(): DomainError {
  return new DomainError(ErrorCode.CONTROL_CANCELLED, "Computer Use cancelled by the local user (Esc)", {
    reason: lastReason,
  });
}

/** Called only by the trusted local Windows activity-helper path. */
export function signalComputerUseCancel(reason = "escape"): void {
  generation += 1;
  lastCancelledAt = Date.now();
  lastReason = reason;
  for (const waiter of [...waiters]) waiter();
}

export function computerUseCancelGeneration(): number {
  return generation;
}

export function isComputerUseRecentlyCancelled(now = Date.now()): boolean {
  return lastCancelledAt > 0 && now - lastCancelledAt < cancelLatchMs;
}

export function wasComputerUseCancelledSince(startGeneration: number): boolean {
  return generation !== startGeneration;
}

export function assertComputerUseNotRecentlyCancelled(): void {
  if (isComputerUseRecentlyCancelled()) throw cancelledError();
}

export function assertComputerUseNotCancelledSince(startGeneration: number): void {
  if (wasComputerUseCancelledSince(startGeneration)) throw cancelledError();
}

/** A delay used by screenshot waitMs that wakes immediately on local Esc. */
export async function waitForComputerUseDelay(ms: number, startGeneration = generation): Promise<void> {
  if (ms <= 0) return;
  assertComputerUseNotCancelledSince(startGeneration);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(onCancel);
      if (error) reject(error);
      else resolve();
    };
    const onCancel = () => {
      if (generation !== startGeneration) finish(cancelledError());
    };
    const timer = setTimeout(() => finish(), ms);
    timer.unref?.();
    waiters.add(onCancel);
  });
}

export function __resetComputerUseCancelForTests(options: { latchMs?: number } = {}): void {
  generation = 0;
  lastCancelledAt = 0;
  lastReason = "escape";
  cancelLatchMs = options.latchMs ?? DEFAULT_CANCEL_LATCH_MS;
  waiters.clear();
}
