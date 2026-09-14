import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserWorkerDriver, BrowserWorkerLaunchInput } from "../agents/browser-controller.js";
import { getBrowserWorkerSession } from "../agents/browser-controller.js";
import { launchPreparedBrowserWorker } from "../agents/browser-launch.js";
import { verifyWorkerCapability } from "../agents/capability.js";
import { getAgentStatus, spawnAgent } from "../agents/manager.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerWebAgentTools } from "./web-agent-tools.js";
import type { Lease, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeCtx(): Promise<ToolContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-recovery-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-recovery-project-"));
  tempDirs.push(stateDir, root);
  const git = async (args: string[]) => (await execFileAsync("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init"]);
  await git(["config", "user.name", "Recovery Test"]);
  await git(["config", "user.email", "recovery@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);

  const projectId = "project-recovery";
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot: root,
    preset: "full-write",
    leaseId: "lease_recovery_test",
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  const registry = [{ projectId, name: projectId, root, aliases: [projectId] }];
  const session = { activeProjectId: projectId, mode: "edit" as const, lease };
  return {
    workspaceRoot: path.dirname(root),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: path.dirname(root),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

type Handler = (input: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;

function handler(server: McpServer, name: string): Handler {
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {};
  const found = tools[name]?.handler;
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Web worker target recovery", () => {
  it("marks a lost target recoverable on agent_status and relaunches the same durable worker", async () => {
    const ctx = await makeCtx();
    const project = ctx.registry[0]!;
    const worker = await spawnAgent(ctx.stateDir, {
      project: { projectId: project.projectId, root: project.root },
      task: "Continue after browser loss",
    });

    let originalToken = "";
    const initialDriver: BrowserWorkerDriver = {
      launch: async (input) => {
        originalToken = input.workerToken;
        return { browserHandle: "fake:lost-target" };
      },
      cancel: async () => undefined,
    };
    await launchPreparedBrowserWorker(ctx.stateDir, initialDriver, worker.workerId);
    expect((await getAgentStatus(ctx.stateDir, worker.workerId)).status).toBe("running");
    expect(await verifyWorkerCapability(ctx.stateDir, originalToken)).toMatchObject({ workerId: worker.workerId });

    let recoveredInput: BrowserWorkerLaunchInput | undefined;
    const recoveryDriver: BrowserWorkerDriver = {
      launch: async (input) => {
        recoveredInput = input;
        return { browserHandle: "fake:recovered-target" };
      },
      cancel: async () => undefined,
    };

    const server = new McpServer({ name: "web-recovery-test", version: "1" });
    registerAgentTools(server, ctx);
    registerWebAgentTools(server, ctx, {
      browserDriver: recoveryDriver,
      browserProbe: { isAlive: async () => false },
    });

    const status = await handler(server, "agent_status")({ workerId: worker.workerId });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      workerId: worker.workerId,
      status: "running",
      browser: {
        status: "failed",
        attempt: 1,
        recoverable: true,
      },
    });
    expect((await getAgentStatus(ctx.stateDir, worker.workerId)).status).toBe("running");
    await expect(verifyWorkerCapability(ctx.stateDir, originalToken)).rejects.toThrow();

    const recovered = await handler(server, "agent_launch")({ workerId: worker.workerId });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      workerId: worker.workerId,
      status: "running",
      browserStatus: "running",
      browserAttempt: 2,
      recovered: true,
    });
    expect(recoveredInput?.workerId).toBe(worker.workerId);
    expect(recoveredInput?.task).toBe("Continue after browser loss");
    expect(recoveredInput?.workerToken).not.toBe(originalToken);
    expect(await verifyWorkerCapability(ctx.stateDir, recoveredInput!.workerToken)).toMatchObject({ workerId: worker.workerId });
    expect((await getBrowserWorkerSession(ctx.stateDir, worker.workerId))?.browserHandle).toBe("fake:recovered-target");
  });

  it("does not disturb a live browser target", async () => {
    const ctx = await makeCtx();
    const project = ctx.registry[0]!;
    const worker = await spawnAgent(ctx.stateDir, {
      project: { projectId: project.projectId, root: project.root },
      task: "Stay on the live target",
    });
    let token = "";
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        token = input.workerToken;
        return { browserHandle: "fake:live-target" };
      },
      cancel: async () => undefined,
    };
    await launchPreparedBrowserWorker(ctx.stateDir, driver, worker.workerId);

    const server = new McpServer({ name: "web-live-test", version: "1" });
    registerAgentTools(server, ctx);
    registerWebAgentTools(server, ctx, {
      browserDriver: driver,
      browserProbe: { isAlive: async () => true },
    });

    const status = await handler(server, "agent_status")({ workerId: worker.workerId });
    expect(status.structuredContent).toMatchObject({
      status: "running",
      browser: { status: "running", recoverable: false },
    });
    expect(await verifyWorkerCapability(ctx.stateDir, token)).toMatchObject({ workerId: worker.workerId });
  });
});
