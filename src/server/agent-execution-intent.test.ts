import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentStatus } from "../agents/manager.js";
import { setWorkerExecutionPreference } from "../agents/execution-settings.js";
import type { Lease, ToolContext } from "../types.js";
import { createServer } from "./mcp-server.js";

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
  const stateDir = await temp("chatgpt2codex-agent-execution-state-");
  const root = await temp("chatgpt2codex-agent-execution-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Agent Execution Test"]);
  await git(root, ["config", "user.email", "agent-execution@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);

  const projectId = "project-agent-execution";
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot: root,
    preset: "full-write",
    leaseId: "lease_agent_execution",
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  const registry = [{ projectId, name: "agent-execution", root, aliases: ["agent-execution"] }];
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

function handlers(server: Awaited<ReturnType<typeof createServer>>): Record<string, Handler> {
  return Object.fromEntries(
    Object.entries(
      (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {},
    ).flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent_spawn execution override", () => {
  it("persists the worker override over project/global defaults before launch", async () => {
    const ctx = await makeCtx();
    const projectId = ctx.registry[0]!.projectId;
    await setWorkerExecutionPreference(ctx.stateDir, "global", {
      model: "gpt-global",
      reasoningEffort: "medium",
    });
    await setWorkerExecutionPreference(
      ctx.stateDir,
      "project",
      { reasoningEffort: "high" },
      projectId,
    );

    const server = await createServer(ctx);
    const spawned = await handlers(server).agent_spawn?.({
      task: "Use a worker-specific execution model",
      execution: { model: "gpt-worker", fallbackPolicy: "allow-current" },
    });

    expect(spawned?.isError).not.toBe(true);
    const workerId = String(spawned?.structuredContent?.workerId);
    const worker = await getAgentStatus(ctx.stateDir, workerId);
    expect(worker.executionIntent).toEqual({
      requested: { model: "gpt-worker", fallbackPolicy: "allow-current" },
      resolved: {
        model: "gpt-worker",
        reasoningEffort: "high",
        fallbackPolicy: "allow-current",
      },
      sources: {
        model: "worker",
        reasoningEffort: "project",
        fallbackPolicy: "worker",
      },
    });
  });
});
