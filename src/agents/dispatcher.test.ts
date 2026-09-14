import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { issueWorkerCapability, revokeWorkerCapability } from "./capability.js";
import { dispatchWorkerCoreTool } from "./dispatcher.js";
import { spawnAgent } from "./manager.js";

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

async function makeFixture() {
  const stateDir = await temp("chatgpt2codex-dispatch-state-");
  const root = await temp("chatgpt2codex-dispatch-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Dispatcher Test"]);
  await git(root, ["config", "user.email", "dispatcher@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);

  const project = { projectId: "project-1", name: "project-1", root, aliases: ["project-1"] };
  const mainSession = {
    version: 1,
    updatedAt: Date.now(),
    activeProjectId: "project-1",
    mode: "edit",
    lease: {
      projectId: "project-1",
      leaseId: "main-lease",
      projectRoot: root,
      preset: "full-write",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  };
  let globalSetSessionCalls = 0;
  const ctx: ToolContext = {
    workspaceRoot: path.dirname(root),
    stateDir,
    registry: [project],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [project],
      saveProjects: async () => undefined,
      getSession: async () => mainSession,
      setSession: async () => {
        globalSetSessionCalls += 1;
      },
    },
    config: {
      workspaceRoot: path.dirname(root),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
    remote: true,
  };

  const worker = await spawnAgent(stateDir, {
    project: { projectId: project.projectId, root },
    task: "Modify only the isolated worktree",
  });
  const capability = await issueWorkerCapability(stateDir, worker.workerId);
  return { stateDir, root, ctx, worker, capability, globalSetSessionCalls: () => globalSetSessionCalls };
}

async function doesNotExist(file: string): Promise<boolean> {
  return access(file).then(() => false).catch(() => true);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker-scoped Core dispatcher", () => {
  it("writes, reads, and commits only inside the worker worktree without touching global session state", async () => {
    const { root, ctx, worker, capability, globalSetSessionCalls } = await makeFixture();
    const worktree = worker.workspace!.worktreePath;

    const created = await dispatchWorkerCoreTool(ctx, capability.token, "file_create", {
      path: "worker-only.txt",
      content: "isolated worker content\n",
    });
    expect(created.isError).not.toBe(true);
    expect(await readFile(path.join(worktree, "worker-only.txt"), "utf8")).toBe("isolated worker content\n");
    expect(await doesNotExist(path.join(root, "worker-only.txt"))).toBe(true);

    const read = await dispatchWorkerCoreTool(ctx, capability.token, "file_read_slice", {
      path: "worker-only.txt",
      start: 1,
      end: 5,
    });
    expect(read.isError).not.toBe(true);
    expect(String(read.structuredContent?.content)).toContain("isolated worker content");

    const committed = await dispatchWorkerCoreTool(ctx, capability.token, "git_commit", {
      message: "worker: isolated change",
      paths: ["worker-only.txt"],
    });
    expect(committed.isError).not.toBe(true);
    expect(committed.structuredContent?.branch).toBe(worker.workspace?.branch);
    expect(await git(root, ["status", "--porcelain"])).toBe("");
    expect(await git(worktree, ["show", "HEAD:worker-only.txt"])).toBe("isolated worker content");
    expect(globalSetSessionCalls()).toBe(0);
  });

  it("injects the authenticated worker project id instead of trusting caller project routing", async () => {
    const { ctx, worker, capability } = await makeFixture();
    const result = await dispatchWorkerCoreTool(ctx, capability.token, "repo_status", {
      projectId: "attacker-controlled-project",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.branch).toBe(worker.workspace?.branch);
  });

  it("rejects Core surfaces outside the worker allowlist", async () => {
    const { ctx, capability } = await makeFixture();
    await expect(dispatchWorkerCoreTool(ctx, capability.token, "project_select", {})).rejects.toThrow(/not allowed/);
    await expect(dispatchWorkerCoreTool(ctx, capability.token, "git_push", {})).rejects.toThrow(/not allowed/);
    await expect(dispatchWorkerCoreTool(ctx, capability.token, "workspace_refresh_index", {})).rejects.toThrow(/not allowed/);
  });

  it("rejects invalid or revoked capabilities before running a Core handler", async () => {
    const { stateDir, ctx, worker, capability } = await makeFixture();
    await expect(dispatchWorkerCoreTool(ctx, `${capability.token}x`, "repo_status", {})).rejects.toThrow(/does not match|Invalid/);

    await revokeWorkerCapability(stateDir, worker.workerId);
    await expect(dispatchWorkerCoreTool(ctx, capability.token, "repo_status", {})).rejects.toThrow(/expired, revoked, or unknown/);
  });
});
