import { afterEach, describe, expect, it } from "vitest";
import type { Lease, ToolContext } from "../types.js";
import { requireProjectLease } from "./lease-guard.js";

const projectId = "project-worker-lease";
const projectRoot = "/tmp/project-worker-lease";

afterEach(() => {
  delete process.env.CHATGPT2CODEX_CONTROL_ACCESS_MODE;
});

function baseConfig() {
  return {
    workspaceRoot: "/tmp",
    stateDir: "/tmp/state",
    maxReadBytes: 1024,
    maxPatchBytes: 1024,
    defaultCommandTimeoutSec: 30,
    defaultLeaseTtlMs: 60_000,
  };
}

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
    config: baseConfig(),
  };
}

function expiredCtxFor(preset: Lease["preset"]): {
  ctx: ToolContext;
  getSession: () => { activeProjectId: string; mode: "read"; lease: Lease; controlLease?: Lease };
  ledgerEvents: Array<{ type: string; [key: string]: unknown }>;
} {
  const now = Date.now();
  let session: { activeProjectId: string; mode: "read"; lease: Lease; controlLease?: Lease } = {
    activeProjectId: projectId,
    mode: "read",
    lease: {
      projectId,
      projectRoot,
      preset,
      leaseId: `expired_${preset}`,
      issuedAt: now - 120_000,
      expiresAt: now - 60_000,
    },
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
    config: baseConfig(),
  };
  return { ctx, getSession: () => session, ledgerEvents };
}

function splitAuthorityCtx(): {
  ctx: ToolContext;
  getSession: () => { activeProjectId: string; mode: "edit"; lease: Lease; controlLease: Lease };
} {
  const now = Date.now();
  let session = {
    activeProjectId: projectId,
    mode: "edit" as const,
    lease: {
      projectId,
      projectRoot,
      preset: "full-write" as const,
      leaseId: "lease_write",
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    controlLease: {
      projectId,
      projectRoot,
      preset: "control" as const,
      leaseId: "lease_control_old",
      issuedAt: now - 120_000,
      expiresAt: now - 60_000,
    },
  };
  const ctx: ToolContext = {
    workspaceRoot: "/tmp",
    stateDir: "/tmp/state",
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => {
        session = next as typeof session;
      },
    },
    config: baseConfig(),
  };
  return { ctx, getSession: () => session };
}

describe("worker orchestration lease capability", () => {
  it("lets explicit Full/Admin mode satisfy every non-control project capability", async () => {
    process.env.CHATGPT2CODEX_CONTROL_ACCESS_MODE = "full";

    for (const capability of ["read", "verify", "write", "image", "remote", "worker"] as const) {
      await expect(requireProjectLease(ctxFor("control"), projectId, capability), capability).resolves.toMatchObject({
        preset: "control",
      });
    }
  });

  it("allows control leases to orchestrate workers without granting direct write", async () => {
    const ctx = ctxFor("control");

    await expect(requireProjectLease(ctx, projectId, "worker")).resolves.toMatchObject({ preset: "control" });
    await expect(requireProjectLease(ctx, projectId, "control")).resolves.toMatchObject({ preset: "control" });
    await expect(requireProjectLease(ctx, projectId, "write")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("keeps full-write worker-capable without granting desktop control by itself", async () => {
    const ctx = ctxFor("full-write");

    await expect(requireProjectLease(ctx, projectId, "worker")).resolves.toMatchObject({ preset: "full-write" });
    await expect(requireProjectLease(ctx, projectId, "write")).resolves.toMatchObject({ preset: "full-write" });
    await expect(requireProjectLease(ctx, projectId, "control")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("does not let read/tests/image presets create workers without a local control grant", async () => {
    for (const preset of ["read-only", "tests-only", "image-only"] as const) {
      await expect(requireProjectLease(ctxFor(preset), projectId, "worker"), preset).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
  });

  it("transparently rolls an expired legacy active control lease and persists the renewed lease", async () => {
    const { ctx, getSession, ledgerEvents } = expiredCtxFor("control");
    const before = getSession().lease;

    const renewed = await requireProjectLease(ctx, projectId, "worker");

    expect(renewed.preset).toBe("control");
    expect(renewed.leaseId).not.toBe(before.leaseId);
    expect(renewed.issuedAt).toBeGreaterThan(before.issuedAt);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
    expect(getSession().lease).toEqual(renewed);
    expect(getSession().controlLease).toEqual(renewed);
    expect(ledgerEvents).toContainEqual(
      expect.objectContaining({ type: "control.lease.renewed", projectId, leaseId: renewed.leaseId }),
    );
  });

  it("keeps durable local control usable while the active project lease is full-write", async () => {
    const { ctx, getSession } = splitAuthorityCtx();
    const activeWriteLeaseId = getSession().lease.leaseId;

    const control = await requireProjectLease(ctx, projectId, "control");

    expect(control.preset).toBe("control");
    expect(control.leaseId).not.toBe("lease_control_old");
    expect(getSession().lease.leaseId).toBe(activeWriteLeaseId);
    expect(getSession().lease.preset).toBe("full-write");
    expect(getSession().controlLease).toEqual(control);
    await expect(requireProjectLease(ctx, projectId, "write")).resolves.toMatchObject({ preset: "full-write" });
  });

  it("does not auto-renew expired non-control leases without a durable control grant", async () => {
    const { ctx, getSession } = expiredCtxFor("full-write");
    const before = getSession().lease;

    await expect(requireProjectLease(ctx, projectId, "worker")).rejects.toMatchObject({
      code: "LEASE_REQUIRED",
    });
    expect(getSession().lease).toEqual(before);
  });
});
