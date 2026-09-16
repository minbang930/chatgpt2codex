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
});
