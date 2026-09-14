import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, ToolContext } from "../types.js";
import { issueWorkerCapability } from "../agents/capability.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function makeGitProject(): Promise<{ root: string; head: string }> {
  const root = await makeTempDir("chatgpt2codex-agent-tools-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Agent Tools Test"]);
  await git(root, ["config", "user.email", "agent-tools@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return { root, head: await git(root, ["rev-parse", "HEAD"]) };
}

function lease(projectId: string, projectRoot: string, preset: Lease["preset"] = "full-write"): Lease {
  const now = Date.now();
  return {
    projectId,
    projectRoot,
    preset,
    leaseId: "lease_agent_tools_test",
    issuedAt: now,
    expiresAt: now + 60_000,
  };
}

async function makeCtx(preset: Lease["preset"] = "full-write"): Promise<ToolContext> {
  const stateDir = await makeTempDir("chatgpt2codex-agent-tools-state-");
  const project = await makeGitProject();
  const projectId = "project-1";
  let session: unknown = {
    activeProjectId: projectId,
    mode: "edit",
    lease: lease(projectId, project.root, preset),
  };

  const registry = [
    {
      projectId,
      name: "project-1",
      root: project.root,
      aliases: ["project-1"],
    },
  ];

  return {
    workspaceRoot: path.dirname(project.root),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => {
        session = next;
      },
    },
    config: {
      workspaceRoot: path.dirname(project.root),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

type RegisteredHandler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function handlers(server: Awaited<ReturnType<typeof createServer>>): Record<string, RegisteredHandler> {
  return Object.fromEntries(
    Object.entries(
      (server as unknown as { _registeredTools?: Record<string, { handler?: RegisteredHandler }> })._registeredTools ?? {},
    ).flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP agent tools", () => {
  it("registers the six planned agent tools with ChatGPT-visible metadata", async () => {
    const server = await createServer(await makeCtx());
    const tools = (server as unknown as {
      _registeredTools?: Record<string, { annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }>;
    })._registeredTools;

    for (const name of ["agent_spawn", "agent_status", "agent_result", "agent_wait", "agent_cancel", "worker_finish"]) {
      expect(tools?.[name], name).toBeDefined();
      expect(tools?.[name]?._meta?.["openai/visibility"], name).toBe("public");
    }
    expect(tools?.agent_status?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools?.agent_spawn?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    const listHandler = (server.server as unknown as {
      _requestHandlers?: Map<string, (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>>;
    })._requestHandlers?.get("tools/list");
    const listed = await listHandler?.({ method: "tools/list", params: {} });
    const names = listed?.tools.map((tool) => tool.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["agent_spawn", "agent_status", "agent_result", "agent_wait", "agent_cancel", "worker_finish"]));
  });

  it("spawns, finishes, waits, and retrieves a worker through MCP handlers", async () => {
    const ctx = await makeCtx();
    const server = await createServer(ctx);
    const tool = handlers(server);

    const spawned = await tool.agent_spawn?.({ task: "Implement isolated change" });
    expect(spawned?.isError).not.toBe(true);
    expect(spawned?.structuredContent?.chatgpt2codexToolCall).toMatchObject({
      namespace: "ChatGPT_To_Codex",
      tool: "agent_spawn",
      ok: true,
    });
    expect(spawned?.structuredContent?.launchState).toBe("prepared");
    expect(spawned?.structuredContent?.status).toBe("pending");
    const workerId = String(spawned?.structuredContent?.workerId);
    expect(workerId).toMatch(/^wrk_[0-9a-f-]{36}$/i);

    const status = await tool.agent_status?.({ workerId });
    expect(status?.structuredContent?.status).toBe("pending");

    const capability = await issueWorkerCapability(ctx.stateDir, workerId);
    const finished = await tool.worker_finish?.({ workerToken: capability.token, summary: "Worker task complete", checks: ["verified"] });
    expect(finished?.isError).not.toBe(true);
    expect(finished?.structuredContent?.status).toBe("completed");
    expect((finished?.structuredContent?.result as { summary?: string } | undefined)?.summary).toBe("Worker task complete");

    const waited = await tool.agent_wait?.({ workerIds: [workerId], timeoutMs: 0 });
    expect(waited?.structuredContent?.timedOut).toBe(false);
    expect(waited?.structuredContent?.events).toEqual([
      expect.objectContaining({ workerId, status: "completed" }),
    ]);

    const waitedAgain = await tool.agent_wait?.({ workerIds: [workerId], timeoutMs: 0 });
    expect(waitedAgain?.structuredContent).toMatchObject({ timedOut: true, events: [] });

    const result = await tool.agent_result?.({ workerId });
    expect(result?.structuredContent?.status).toBe("completed");
    expect((result?.structuredContent?.result as { summary?: string } | undefined)?.summary).toBe("Worker task complete");
  });

  it("requires a full-write-capable lease for agent_spawn", async () => {
    const server = await createServer(await makeCtx("tests-only"));
    const tool = handlers(server);
    const spawned = await tool.agent_spawn?.({ task: "Should not start" });

    expect(spawned?.isError).toBe(true);
    expect(spawned?.structuredContent).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("cancels a prepared worker without removing its managed workspace", async () => {
    const server = await createServer(await makeCtx());
    const tool = handlers(server);
    const spawned = await tool.agent_spawn?.({ task: "Cancel me" });
    const workerId = String(spawned?.structuredContent?.workerId);

    const cancelled = await tool.agent_cancel?.({ workerId, reason: "user changed direction" });
    expect(cancelled?.structuredContent).toMatchObject({
      workerId,
      status: "cancelled",
      workspaceRemoved: false,
    });

    const result = await tool.agent_result?.({ workerId });
    expect(result?.structuredContent).toMatchObject({
      workerId,
      status: "cancelled",
      error: "user changed direction",
    });
  });
});
