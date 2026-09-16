import { describe, expect, it } from "vitest";
import type { Lease, ToolContext } from "../types.js";
import { requireProjectLease } from "./lease-guard.js";

const projectId = "project-worker-lease";
const projectRoot = "/tmp/project-worker-lease";

function ctxFor(preset: Lease["preset"]): ToolContext {
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot,
    preset,
    leaseId: `lease_${preset}`,
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  return {
    workspaceRoot: "/tmp",
    stateDir: "/tmp/state",
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => ({ activeProjectId: projectId, lease }),
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir: "/tmp/state",
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 60_000,
    },
  };
}

function expiredCtxFor(preset: Lease["preset"]): {
  ctx: ToolContext;
  getSession: () => { activeProjectId: string; mode: "read"; lease: Lease };
  ledgerEvents: Array<{ type: string; [key: string]: unknown }>;
} {
  const now = Date.now();
  let session = {
    activeProjectId: projectId,
    mode: "read" as const,
    lease: {
      projectId,
      projectRoot,
      preset,
      leaseId: `expired_${preset}`,
      issuedAt: now - 120_000,
      expiresAt: now - 60_000,
    } satisfies Lease,
  };
  const ledgerEvents: Array<{ type: string; [key: string]: unknown }> = [];
  const ctx: ToolContext = {
    workspaceRoot: "/tmp",
    stateDir: "/tmp/state",
    registry: [],
    ledger: {
      append: async (event) => {
        ledgerEvents.push(event);
      },
    },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => {
        session = next as typeof session;
      },
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir: "/tmp/state",
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 60_000,
    },
  };
  return { ctx, getSession: () => session, ledgerEvents };
}

describe("worker orchestration lease capability", () => {
  it("allows control leases to orchestrate workers without granting direct write", async () => {
    const ctx = ctxFor("control");

    await expect(requireProjectLease(ctx, projectId, "worker")).resolves.toMatchObject({ preset: "control" });
    await expect(requireProjectLease(ctx, projectId, "control")).resolves.toMatchObject({ preset: "control" });
    await expect(requireProjectLease(ctx, projectId, "write")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("keeps full-write worker-capable without granting desktop control", async () => {
    const ctx = ctxFor("full-write");

    await expect(requireProjectLease(ctx, projectId, "worker")).resolves.toMatchObject({ preset: "full-write" });
    await expect(requireProjectLease(ctx, projectId, "write")).resolves.toMatchObject({ preset: "full-write" });
    await expect(requireProjectLease(ctx, projectId, "control")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("does not let read/tests/image presets create workers", async () => {
    for (const preset of ["read-only", "tests-only", "image-only"] as const) {
      await expect(requireProjectLease(ctxFor(preset), projectId, "worker"), preset).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
  });

  it("transparently rolls an expired control lease and persists the renewed lease", async () => {
    const { ctx, getSession, ledgerEvents } = expiredCtxFor("control");
    const before = getSession().lease;

    const renewed = await requireProjectLease(ctx, projectId, "worker");

    expect(renewed.preset).toBe("control");
    expect(renewed.leaseId).not.toBe(before.leaseId);
    expect(renewed.issuedAt).toBeGreaterThan(before.issuedAt);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
    expect(getSession().lease).toEqual(renewed);
    expect(ledgerEvents).toContainEqual(
      expect.objectContaining({ type: "control.lease.renewed", projectId, leaseId: renewed.leaseId }),
    );
  });

  it("does not auto-renew expired non-control leases", async () => {
    const { ctx, getSession } = expiredCtxFor("full-write");
    const before = getSession().lease;

    await expect(requireProjectLease(ctx, projectId, "worker")).rejects.toMatchObject({
      code: "LEASE_REQUIRED",
    });
    expect(getSession().lease).toEqual(before);
  });
});
