import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserWorkerDriver, BrowserWorkerLaunchInput } from "../agents/browser-controller.js";
import { launchPreparedBrowserWorker } from "../agents/browser-launch.js";
import { verifyWorkerCapability } from "../agents/capability.js";
import { getAgentStatus, spawnAgent } from "../agents/manager.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerWebAgentTools } from "./web-agent-tools.js";
import type { Lease, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeCtx(): Promise<ToolContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-parallel-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-parallel-project-"));
  tempDirs.push(stateDir, root);
  const git = async (args: string[]) => (await execFileAsync("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init"]);
  await git(["config", "user.name", "Parallel Test"]);
  await git(["config", "user.email", "parallel@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);

  const projectId = "project-parallel";
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot: root,
    preset: "full-write",
    leaseId: "lease_parallel_test",
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

describe("parallel Web worker recovery", () => {
  it("recovers one lost worker without disturbing a sibling worker", async () => {
    const ctx = await makeCtx();
    const project = ctx.registry[0]!;
    const workerA = await spawnAgent(ctx.stateDir, {
      project: { projectId: project.projectId, root: project.root },
      task: "Worker A",
    });
    const workerB = await spawnAgent(ctx.stateDir, {
      project: { projectId: project.projectId, root: project.root },
      task: "Worker B",
    });
    expect(workerA.workspace?.worktreePath).not.toBe(workerB.workspace?.worktreePath);
    expect(workerA.workspace?.branch).not.toBe(workerB.workspace?.branch);

    const tokens = new Map<string, string[]>();
    const handles = new Map<string, string>();
    const driver: BrowserWorkerDriver = {
      launch: async (input: BrowserWorkerLaunchInput) => {
        const attempts = tokens.get(input.workerId) ?? [];
        attempts.push(input.workerToken);
        tokens.set(input.workerId, attempts);
        const handle = `fake:${input.workerId}:${attempts.length}`;
        handles.set(input.workerId, handle);
        return { browserHandle: handle };
      },
      cancel: async () => undefined,
    };
    await Promise.all([
      launchPreparedBrowserWorker(ctx.stateDir, driver, workerA.workerId),
      launchPreparedBrowserWorker(ctx.stateDir, driver, workerB.workerId),
    ]);

    const alive = new Map<string, boolean>([
      [handles.get(workerA.workerId)!, false],
      [handles.get(workerB.workerId)!, true],
    ]);
    const server = new McpServer({ name: "parallel-worker-test", version: "1" });
    registerAgentTools(server, ctx);
    registerWebAgentTools(server, ctx, {
      browserDriver: driver,
      browserProbe: { isAlive: async (browserHandle) => alive.get(browserHandle ?? "") ?? false },
    });

    const statusA = await handler(server, "agent_status")({ workerId: workerA.workerId });
    const statusB = await handler(server, "agent_status")({ workerId: workerB.workerId });
    expect(statusA.structuredContent).toMatchObject({
      workerId: workerA.workerId,
      status: "running",
      browser: { status: "failed", recoverable: true },
    });
    expect(statusB.structuredContent).toMatchObject({
      workerId: workerB.workerId,
      status: "running",
      browser: { status: "running", recoverable: false },
    });

    const tokenA1 = tokens.get(workerA.workerId)![0]!;
    const tokenB1 = tokens.get(workerB.workerId)![0]!;
    await expect(verifyWorkerCapability(ctx.stateDir, tokenA1)).rejects.toThrow();
    expect(await verifyWorkerCapability(ctx.stateDir, tokenB1)).toMatchObject({ workerId: workerB.workerId });

    const recoveredA = await handler(server, "agent_launch")({ workerId: workerA.workerId });
    expect(recoveredA.structuredContent).toMatchObject({
      workerId: workerA.workerId,
      status: "running",
      browserAttempt: 2,
      recovered: true,
    });
    expect(tokens.get(workerA.workerId)).toHaveLength(2);
    expect(tokens.get(workerB.workerId)).toHaveLength(1);
    expect((await getAgentStatus(ctx.stateDir, workerB.workerId)).status).toBe("running");
    expect(await verifyWorkerCapability(ctx.stateDir, tokenB1)).toMatchObject({ workerId: workerB.workerId });
  });
});
