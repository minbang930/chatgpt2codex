import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserWorkerDriver } from "../agents/browser-controller.js";
import { getBrowserWorkerSession } from "../agents/browser-controller.js";
import { launchPreparedBrowserWorker } from "../agents/browser-launch.js";
import { verifyWorkerCapability } from "../agents/capability.js";
import { getAgentStatus, spawnAgent } from "../agents/manager.js";
import type { Lease, ToolContext } from "../types.js";
import { registerWebAgentTools } from "./web-agent-tools.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeCtx(): Promise<ToolContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-stop-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-stop-project-"));
  tempDirs.push(stateDir, root);
  const git = async (args: string[]) => (await execFileAsync("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init"]);
  await git(["config", "user.name", "Stop Test"]);
  await git(["config", "user.email", "stop@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);

  const projectId = "project-stop";
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot: root,
    preset: "full-write",
    leaseId: "lease_stop_test",
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

describe("agent_stop", () => {
  it("closes the worker tab, revokes access, cancels the worker, and preserves its worktree", async () => {
    const ctx = await makeCtx();
    const project = ctx.registry[0]!;
    const worker = await spawnAgent(ctx.stateDir, {
      project: { projectId: project.projectId, root: project.root },
      task: "Make a partial change",
    });

    let cancelledHandle: string | undefined;
    let issuedToken = "";
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        issuedToken = input.workerToken;
        return { browserHandle: "fake:stop-tab" };
      },
      cancel: async (input) => {
        cancelledHandle = input.browserHandle;
      },
    };
    await launchPreparedBrowserWorker(ctx.stateDir, driver, worker.workerId);

    const server = new McpServer({ name: "stop-test", version: "1" });
    registerWebAgentTools(server, ctx, { browserDriver: driver });
    const stopped = await handler(server, "agent_stop")({ workerId: worker.workerId, reason: "parent cancelled" });

    expect(stopped.isError).not.toBe(true);
    expect(stopped.structuredContent).toMatchObject({
      workerId: worker.workerId,
      status: "cancelled",
      browserStopped: true,
      workspaceRemoved: false,
    });
    expect(cancelledHandle).toBe("fake:stop-tab");
    expect((await getBrowserWorkerSession(ctx.stateDir, worker.workerId))?.status).toBe("stopped");
    expect((await getAgentStatus(ctx.stateDir, worker.workerId)).status).toBe("cancelled");
    await expect(verifyWorkerCapability(ctx.stateDir, issuedToken)).rejects.toThrow();
  });
});
