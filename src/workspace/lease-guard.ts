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
  controlLease?: Lease | null;
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

async function renewControlLease(
  ctx: ToolContext,
  session: unknown,
  projectId: string,
  controlLease: Lease,
): Promise<Lease> {
  if (Date.now() <= controlLease.expiresAt) return controlLease;

  const renewed = renewLease(controlLease);
  const state = sessionObject(session) ?? {};
  const active = state.lease;
  const activeIsSameControlLease =
    active?.preset === "control" && active.projectId === projectId && active.leaseId === controlLease.leaseId;

  await ctx.store.setSession({
    ...state,
    ...(activeIsSameControlLease ? { lease: renewed } : {}),
    controlLease: renewed,
  });
  await ctx.ledger.append({
    type: "control.lease.renewed",
    projectId,
    leaseId: renewed.leaseId,
    issuedAt: renewed.issuedAt,
    expiresAt: renewed.expiresAt,
  });
  return renewed;
}

/**
 * Require authority for `projectId` that permits `capability`.
 *
 * Normal project presets still expire normally. Locally armed desktop-control
 * authorization is persisted separately by the state store and rolls forward
 * transparently after expiry. This keeps Computer Use/worker orchestration
 * available even if the main project lease later switches to full-write or
 * another preset. Remote MCP callers still cannot mint control authority.
 *
 * The desktop-control kill switch is intentionally independent: renewing a
 * control lease never clears a kill. A fresh local control grant is still
 * required to resume after a kill.
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
    return renewControlLease(ctx, session, projectId, localControlLease);
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
