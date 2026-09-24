import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { isControlFullAccess } from "../control/policy.js";
import { makeLease, renewLease, requireLease } from "./project-select.js";

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
  controlLease?: Lease | null;
  adminControlLease?: Lease | null;
  [key: string]: unknown;
}

function sessionObject(session: unknown): SessionWithLease | undefined {
  return typeof session === "object" && session !== null ? (session as SessionWithLease) : undefined;
}

function capabilityAllowed(lease: Lease, capability: LeaseCapability): boolean {
  return ALLOWED_CAPABILITIES[lease.preset].has(capability);
}

/**
 * Return the durable local control authorization for the active project.
 * Before `controlLease` existed, an active control lease itself was the only
 * persisted proof of local arming, so keep that backward-compatible fallback.
 */
function controlLeaseForSession(session: unknown, projectId: string): Lease | undefined {
  const state = sessionObject(session);
  if (!state || state.activeProjectId !== projectId) return undefined;

  const candidate = state.controlLease ?? (
    state.lease?.preset === "control" ? state.lease : state.activeLease?.preset === "control" ? state.activeLease : undefined
  );
  if (!candidate || candidate.projectId !== projectId || candidate.preset !== "control") return undefined;
  return candidate;
}

function adminControlLeaseForSession(session: unknown, projectId: string): Lease | undefined {
  if (!isControlFullAccess()) return undefined;
  const state = sessionObject(session);
  if (!state || state.activeProjectId !== projectId) return undefined;
  const candidate = state.adminControlLease;
  if (!candidate || candidate.projectId !== projectId || candidate.preset !== "control") return undefined;
  return candidate;
}

type ControlLeaseLane = "controlLease" | "adminControlLease";

async function renewPersistedControlLease(
  ctx: ToolContext,
  session: unknown,
  projectId: string,
  controlLease: Lease,
  lane: ControlLeaseLane,
): Promise<Lease> {
  if (Date.now() <= controlLease.expiresAt) return controlLease;

  const renewed = renewLease(controlLease);
  const state = sessionObject(session) ?? {};
  const active = state.lease;
  const activeIsSameControlLease =
    lane === "controlLease" &&
    active?.preset === "control" &&
    active.projectId === projectId &&
    active.leaseId === controlLease.leaseId;

  await ctx.store.setSession({
    ...state,
    ...(activeIsSameControlLease ? { lease: renewed } : {}),
    [lane]: renewed,
  });
  await ctx.ledger.append({
    type: lane === "adminControlLease" ? "control.lease.admin_renewed" : "control.lease.renewed",
    projectId,
    leaseId: renewed.leaseId,
    issuedAt: renewed.issuedAt,
    expiresAt: renewed.expiresAt,
  });
  return renewed;
}

/**
 * Mint Full/Admin control authority for the currently active project. This is
 * intentionally separate from the explicit local `controlLease` lane: the
 * returned lease is recognized only while Full/Admin mode remains enabled.
 */
export async function grantAdminControlLease(
  ctx: ToolContext,
  projectId: string,
  projectRoot: string,
): Promise<Lease> {
  if (!isControlFullAccess()) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Full Computer Use (Admin) is not enabled", { projectId });
  }

  const session = await ctx.store.getSession();
  const state = sessionObject(session) ?? {};
  if (state.activeProjectId !== projectId) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Active project changed before Admin control authorization", { projectId });
  }

  const existing = adminControlLeaseForSession(session, projectId);
  if (existing) {
    return renewPersistedControlLease(ctx, session, projectId, existing, "adminControlLease");
  }

  const lease = makeLease(
    { projectId, name: projectId, root: projectRoot, aliases: [] },
    "control",
  );
  await ctx.store.setSession({ ...state, adminControlLease: lease });
  await ctx.ledger.append({
    type: "control.lease.admin_granted",
    projectId,
    leaseId: lease.leaseId,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
  });
  return lease;
}

export async function revokeAdminControlLease(ctx: ToolContext, projectId?: string): Promise<void> {
  const session = await ctx.store.getSession();
  const state = sessionObject(session);
  const existing = state?.adminControlLease;
  if (!state || !existing || (projectId && existing.projectId !== projectId)) return;

  await ctx.store.setSession({ ...state, adminControlLease: null });
  await ctx.ledger.append({
    type: "control.lease.admin_revoked",
    projectId: existing.projectId,
    leaseId: existing.leaseId,
  });
}

/**
 * Require authority for `projectId` that permits `capability`.
 *
 * Normal project presets still expire normally. Explicit local desktop-control
 * authorization is persisted separately by the state store and rolls forward
 * transparently after expiry. Full/Admin mode has a second persisted lane.
 * While the locally configured Full/Admin mode is active, that owner-authorized
 * lane can satisfy every project capability for the active project. Desktop
 * `control` remains a special case: it is still auto-minted only by the
 * Computer Use boundary so the Kill Switch cannot be bypassed by a generic
 * project-tool call.
 *
 * For non-control capabilities this function may auto-mint Admin authority
 * from the active project's persisted lease metadata. The Computer Use tool
 * boundary remains responsible for auto-minting `control` authority after it
 * has verified that the Kill Switch is not set.
 */
export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
): Promise<Lease> {
  const session = await ctx.store.getSession();
  let activeLease: Lease | undefined;
  let activeError: unknown;

  try {
    activeLease = requireLease(session, projectId);
  } catch (error) {
    activeError = error;
  }

  if (activeLease && capabilityAllowed(activeLease, capability)) {
    return activeLease;
  }

  const localControlLease = controlLeaseForSession(session, projectId);
  if (localControlLease && capabilityAllowed(localControlLease, capability)) {
    return renewPersistedControlLease(ctx, session, projectId, localControlLease, "controlLease");
  }

  const adminControlLease = adminControlLeaseForSession(session, projectId);
  if (adminControlLease) {
    return renewPersistedControlLease(ctx, session, projectId, adminControlLease, "adminControlLease");
  }

  if (capability !== "control" && isControlFullAccess()) {
    const state = sessionObject(session);
    const projectRoot = [state?.lease, state?.activeLease, state?.controlLease]
      .find((candidate) => candidate?.projectId === projectId)?.projectRoot;
    if (projectRoot) {
      return grantAdminControlLease(ctx, projectId, projectRoot);
    }
  }

  if (activeLease) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${activeLease.preset} does not allow ${capability}`, {
      projectId,
      preset: activeLease.preset,
      capability,
    });
  }

  if (activeError) throw activeError;
  throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active lease for project", { projectId });
}
