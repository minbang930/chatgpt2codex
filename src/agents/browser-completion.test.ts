import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserWorkerDriver } from "./browser-controller.js";
import { getBrowserWorkerSession } from "./browser-controller.js";
import { installWorkerCompletionBrowserCleanup } from "./browser-completion.js";
import { launchPreparedBrowserWorker } from "./browser-launch.js";
import { getAgentResult, spawnAgent } from "./manager.js";
import { registerAgentTools } from "../server/agent-tools.js";
import type { Lease, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeCtx(): Promise<ToolContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-finish-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-finish-project-"));
  tempDirs.push(stateDir, root);
  const git = async (args: string[]) => (await execFileAsync("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init"]);
  await git(["config", "user.name", "Finish Test"]);
  await git(["config", "user.email", "finish@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);

  const projectId = "project-finish";
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot: root,
    preset: "full-write",
    leaseId: "lease_finish_test",
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

function finishHandler(server: McpServer): Handler {
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {};
  const handler = tools.worker_finish?.handler;
  if (!handler) throw new Error("worker_finish not registered");
  return handler;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker completion browser cleanup", () => {
  it("stores completion first and then retires the browser tab", async () => {
    const ctx = await makeCtx();
    const project = ctx.registry[0]!;
    const worker = await spawnAgent(ctx.stateDir, {
      project: { projectId: project.projectId, root: project.root },
      task: "Finish and close the worker tab",
    });

    let token = "";
    let cancelledHandle: string | undefined;
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        token = input.workerToken;
        return { browserHandle: "fake:finish-tab" };
      },
      cancel: async (input) => {
        cancelledHandle = input.browserHandle;
      },
    };
    await launchPreparedBrowserWorker(ctx.stateDir, driver, worker.workerId);

    const server = new McpServer({ name: "finish-browser-test", version: "1" });
    registerAgentTools(server, ctx);
    installWorkerCompletionBrowserCleanup(server, ctx.stateDir, driver);

    const finished = await finishHandler(server)({ workerToken: token, summary: "Task completed" });
    expect(finished.isError).not.toBe(true);
    expect(finished.structuredContent).toMatchObject({ status: "completed" });
    expect((await getAgentResult(ctx.stateDir, worker.workerId)).status).toBe("completed");
    expect(cancelledHandle).toBe("fake:finish-tab");
    expect((await getBrowserWorkerSession(ctx.stateDir, worker.workerId))?.status).toBe("stopped");
  });

  it("does not lose a durable result when browser retirement fails", async () => {
    const ctx = await makeCtx();
    const project = ctx.registry[0]!;
    const worker = await spawnAgent(ctx.stateDir, {
      project: { projectId: project.projectId, root: project.root },
      task: "Finish even if browser close fails",
    });

    let token = "";
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        token = input.workerToken;
        return { browserHandle: "fake:broken-close" };
      },
      cancel: async () => {
        throw new Error("target close failed");
      },
    };
    await launchPreparedBrowserWorker(ctx.stateDir, driver, worker.workerId);

    const server = new McpServer({ name: "finish-browser-failure-test", version: "1" });
    registerAgentTools(server, ctx);
    installWorkerCompletionBrowserCleanup(server, ctx.stateDir, driver);

    const finished = await finishHandler(server)({ workerToken: token, summary: "Durable completion wins" });
    expect(finished.isError).not.toBe(true);
    const result = await getAgentResult(ctx.stateDir, worker.workerId);
    expect(result).toMatchObject({ status: "completed", result: { summary: "Durable completion wins" } });
    expect((await getBrowserWorkerSession(ctx.stateDir, worker.workerId))?.status).toBe("failed");
  });
});
