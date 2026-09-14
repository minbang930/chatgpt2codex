import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserWorkerDriver, BrowserWorkerLaunchInput } from "../agents/browser-controller.js";
import { getBrowserWorkerSession } from "../agents/browser-controller.js";
import { getAgentStatus, spawnAgent } from "../agents/manager.js";
import type { Lease, ToolContext } from "../types.js";
import { registerWebAgentTools } from "./web-agent-tools.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function makeCtx(): Promise<ToolContext> {
  const stateDir = await temp("chatgpt2codex-web-agent-state-");
  const root = await temp("chatgpt2codex-web-agent-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Web Agent Test"]);
  await git(root, ["config", "user.email", "web-agent@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);

  const projectId = "project-web-agent";
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot: root,
    preset: "full-write",
    leaseId: "lease_web_agent_test",
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  const registry = [{ projectId, name: "web-agent", root, aliases: ["web-agent"] }];
  let session: unknown = { activeProjectId: projectId, mode: "edit", lease };

  return {
    workspaceRoot: path.dirname(root),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => { session = next; },
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

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function handlers(server: McpServer): Record<string, Handler> {
  return Object.fromEntries(
    Object.entries(
      (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {},
    ).flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

function serverWith(ctx: ToolContext, driver: BrowserWorkerDriver): McpServer {
  const server = new McpServer({ name: "web-agent-tools-test", version: "1" });
  registerWebAgentTools(server, ctx, { browserDriver: driver });
  return server;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Web agent MCP tools", () => {
  it("launches a prepared worker inside the configured ChatGPT Project", async () => {
    const ctx = await makeCtx();
    const active = ctx.registry[0]!;
    const worker = await spawnAgent(ctx.stateDir, {
      project: { projectId: active.projectId, root: active.root },
      task: "Implement the migration",
    });
    let launchInput: BrowserWorkerLaunchInput | undefined;
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        launchInput = input;
        return { browserHandle: "fake:worker-tab" };
      },
      cancel: async () => undefined,
    };
    const tool = handlers(serverWith(ctx, driver));

    const routed = await tool.agent_project_route_set?.({
      url: "https://chatgpt.com/g/g-p-example/project",
      label: "Repo Project",
    });
    expect(routed?.isError).not.toBe(true);

    const launched = await tool.agent_launch?.({ workerId: worker.workerId });
    expect(launched?.isError).not.toBe(true);
    expect(launched?.structuredContent).toMatchObject({
      workerId: worker.workerId,
      status: "running",
      browserStatus: "running",
      browserRoute: "project",
    });
    expect(launchInput?.route).toMatchObject({
      mode: "project",
      projectRef: { label: "Repo Project" },
    });
    expect(launchInput?.task).toBe("Implement the migration");
    expect(launchInput?.workerToken).toMatch(/^wcap\.wrk_/);
    expect((await getAgentStatus(ctx.stateDir, worker.workerId)).status).toBe("running");
  });

  it("keeps a failed browser launch pending and allows a fresh retry", async () => {
    const ctx = await makeCtx();
    const active = ctx.registry[0]!;
    const worker = await spawnAgent(ctx.stateDir, {
      project: { projectId: active.projectId, root: active.root },
      task: "Retry browser launch",
    });

    const failing = serverWith(ctx, {
      launch: async () => { throw new Error("browser unavailable"); },
      cancel: async () => undefined,
    });
    const failed = await handlers(failing).agent_launch?.({ workerId: worker.workerId });
    expect(failed?.isError).toBe(true);
    expect(failed?.structuredContent).toMatchObject({ workerId: worker.workerId, retryable: true });
    expect((await getAgentStatus(ctx.stateDir, worker.workerId)).status).toBe("pending");
    expect((await getBrowserWorkerSession(ctx.stateDir, worker.workerId))?.status).toBe("failed");

    const retrying = serverWith(ctx, {
      launch: async () => ({ browserHandle: "fake:retry-tab" }),
      cancel: async () => undefined,
    });
    const retried = await handlers(retrying).agent_launch?.({ workerId: worker.workerId });
    expect(retried?.isError).not.toBe(true);
    expect(retried?.structuredContent).toMatchObject({
      workerId: worker.workerId,
      status: "running",
      browserAttempt: 2,
    });
  });

  it("can read and clear the active project's ChatGPT Project route", async () => {
    const ctx = await makeCtx();
    const server = serverWith(ctx, {
      launch: async () => ({ browserHandle: "unused" }),
      cancel: async () => undefined,
    });
    const tool = handlers(server);

    const before = await tool.agent_project_route_get?.({});
    expect(before?.structuredContent).toMatchObject({ configured: false });

    await tool.agent_project_route_set?.({ url: "https://chatgpt.com/g/g-p-example/project" });
    const configured = await tool.agent_project_route_get?.({});
    expect(configured?.structuredContent).toMatchObject({ configured: true });

    const cleared = await tool.agent_project_route_clear?.({});
    expect(cleared?.structuredContent).toMatchObject({ cleared: true });
    const after = await tool.agent_project_route_get?.({});
    expect(after?.structuredContent).toMatchObject({ configured: false });
  });
});
