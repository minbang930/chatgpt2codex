import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { requireLease } from "./project-select.js";

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

/**
 * Require an unexpired lease for `projectId` that permits `capability`.
 * Throws LEASE_REQUIRED (no/expired/mismatched lease) or PERMISSION_DENIED
 * (lease exists but its preset does not grant the requested capability).
 */
export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
): Promise<Lease> {
  const session = await ctx.store.getSession();
  const lease = requireLease(session, projectId);
  if (!ALLOWED_CAPABILITIES[lease.preset].has(capability)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${lease.preset} does not allow ${capability}`, {
      projectId,
      preset: lease.preset,
      capability,
    });
  }
  return lease;
}
