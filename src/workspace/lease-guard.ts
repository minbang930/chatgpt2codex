import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { renewLease, requireLease } from "./project-select.js";

/**
 * Capability ceiling checked against the active project lease's preset.
 * Shared by src/server/tools.ts (file/command/git tools), worker orchestration,
 * and src/control/tools.ts (desktop-control tools) so all paths enforce the
 * same preset -> capability table from a single source of truth.
 *
 * `worker` authorizes only bounded worker lifecycle/orchestration operations
 * such as creating an isolated managed worktree and launching its browser
 * worker. It does not authorize direct project writes.
 */
export type LeaseCapability = "read" | "verify" | "write" | "image" | "remote" | "control" | "worker";

const ALLOWED_CAPABILITIES: Record<LeasePreset, ReadonlySet<LeaseCapability>> = {
  "read-only": new Set(["read"]),
  "tests-only": new Set(["read", "verify"]),
  "full-write": new Set(["read", "verify", "write", "image", "remote", "worker"]),
  "image-only": new Set(["read", "image"]),
  control: new Set(["read", "control", "worker"]),
};

interface SessionWithLease {
  activeProjectId?: string | null;
  lease?: Lease | null;
  activeLease?: Lease | null;
  [key: string]: unknown;
}

function sessionObject(session: unknown): SessionWithLease | undefined {
  return typeof session === "object" && session !== null ? (session as SessionWithLease) : undefined;
}

/**
 * A persisted control lease is itself proof that the owner armed control from
 * a local surface: remote /mcp project_select is forbidden from granting the
 * control preset. That lets the runtime hide the short lease TTL from normal
 * use by rolling an expired control lease forward on demand.
 *
 * This deliberately does not clear the desktop-control kill switch. After a
 * kill, a fresh local control grant is still required to resume input.
 */
function expiredRenewableControlLease(session: unknown, projectId: string): Lease | undefined {
  const state = sessionObject(session);
  if (!state) return undefined;
  if (state.activeProjectId !== undefined && state.activeProjectId !== null && state.activeProjectId !== projectId) {
    return undefined;
  }
  const lease = state.lease ?? state.activeLease;
  if (!lease) return undefined;
  if (lease.projectId !== projectId || lease.preset !== "control") return undefined;
  return Date.now() > lease.expiresAt ? lease : undefined;
}

/**
 * Require a lease for `projectId` that permits `capability`.
 *
 * Normal presets still expire normally. A locally armed `control` lease rolls
 * forward transparently after expiry so users do not have to re-arm it every
 * 30 minutes; remote callers still cannot mint control authority themselves.
 * Throws LEASE_REQUIRED (no/mismatched/non-renewable expired lease) or
 * PERMISSION_DENIED (lease exists but its preset lacks the capability).
 */
export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
): Promise<Lease> {
  const session = await ctx.store.getSession();
  let lease: Lease;

  try {
    lease = requireLease(session, projectId);
  } catch (error) {
    const renewable = expiredRenewableControlLease(session, projectId);
    if (!(error instanceof DomainError) || error.code !== ErrorCode.LEASE_REQUIRED || !renewable) {
      throw error;
    }

    lease = renewLease(renewable);
    const state = sessionObject(session);
    await ctx.store.setSession({
      ...(state ?? {}),
      activeProjectId: projectId,
      lease,
    });
    await ctx.ledger.append({
      type: "control.lease.renewed",
      projectId,
      leaseId: lease.leaseId,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
    });
  }

  if (!ALLOWED_CAPABILITIES[lease.preset].has(capability)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${lease.preset} does not allow ${capability}`, {
      projectId,
      preset: lease.preset,
      capability,
    });
  }
  return lease;
}
