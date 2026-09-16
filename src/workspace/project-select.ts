import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCode,
  type Lease,
  type LeasePreset,
  type ProjectRegistryEntry,
} from "../types.js";

/** Default lease TTL when no config is threaded in (PRD §7 Project Lease). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function leaseWindow(): { leaseId: string; issuedAt: number; expiresAt: number } {
  const issuedAt = Date.now();
  return {
    leaseId: `lease_${randomUUID()}`,
    issuedAt,
    expiresAt: issuedAt + DEFAULT_LEASE_TTL_MS,
  };
}

/**
 * Issue a new active project Lease (PRD §7 Project Lease / §8.2
 * project_select) for the given registry entry and preset.
 */
export function makeLease(entry: ProjectRegistryEntry, preset: LeasePreset): Lease {
  return {
    projectId: entry.projectId,
    projectRoot: entry.root,
    preset,
    ...leaseWindow(),
  };
}

/**
 * Roll an already-authorized lease forward without changing its project or
 * preset. This helper does not decide whether renewal is allowed; callers must
 * enforce that policy before invoking it. In particular, the shared lease
 * guard only auto-renews an expired `control` lease, because `control` can be
 * armed only from the local owner-controlled surface.
 */
export function renewLease(lease: Lease): Lease {
  return {
    ...lease,
    ...leaseWindow(),
  };
}

/** Shape session state is expected to carry the active lease under (PRD §10 sessions.json). */
interface SessionWithLease {
  lease?: Lease;
  activeLease?: Lease;
}

function isSessionWithLease(session: unknown): session is SessionWithLease {
  return typeof session === "object" && session !== null;
}

/**
 * Look up and validate the active lease for `projectId` from session state.
 *
 * @throws {DomainError} LEASE_REQUIRED if no valid lease exists for the project.
 */
export function requireLease(session: unknown, projectId: string): Lease {
  if (!isSessionWithLease(session)) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active session/lease", { projectId });
  }

  const lease = session.lease ?? session.activeLease;
  if (!lease) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active lease for project", { projectId });
  }

  if (lease.projectId !== projectId) {
    throw new DomainError(
      ErrorCode.LEASE_REQUIRED,
      "Active lease is for a different project",
      { projectId, leaseProjectId: lease.projectId },
    );
  }

  if (Date.now() > lease.expiresAt) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Lease expired", {
      projectId,
      expiresAt: lease.expiresAt,
    });
  }

  return lease;
}
