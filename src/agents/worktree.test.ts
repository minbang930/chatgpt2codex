import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createWorker, getWorker } from "./store.js";
import {
  provisionWorkerWorktree,
  removeWorkerWorktree,
  verifyWorkerWorktree,
  workerBranch,
} from "./worktree.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function initRepository(): Promise<{ root: string; initialCommit: string }> {
  const root = await makeTempDir("chatgpt2codex-worker-repo-");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "chatgpt2codex tests"]);
  await git(root, ["config", "user.email", "tests@example.invalid"]);
  await fs.writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "baseline"]);
  return { root, initialCommit: await git(root, ["rev-parse", "HEAD"]) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("agents/worktree", () => {
  it("provisions an isolated branch/worktree under runtime state and persists the assignment", async () => {
    const { root, initialCommit } = await initRepository();
    const stateDir = await makeTempDir("chatgpt2codex-worker-state-");
    const worker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Implement an isolated change",
    });

    const provisioned = await provisionWorkerWorktree(stateDir, root, worker.workerId);
    expect(provisioned.workspace?.branch).toBe(workerBranch(worker.workerId));
    expect(provisioned.workspace?.baseCommit).toBe(initialCommit);
    expect(provisioned.workspace?.worktreePath.startsWith(path.join(stateDir, "agents", "worktrees"))).toBe(true);
    expect(provisioned.workspace?.worktreePath.startsWith(root)).toBe(false);

    const verified = await verifyWorkerWorktree(stateDir, root, provisioned);
    expect(verified.branch).toBe(workerBranch(worker.workerId));
    expect(verified.head).toBe(initialCommit);
    expect(await git(verified.worktreePath, ["branch", "--show-current"])).toBe(workerBranch(worker.workerId));

    const persisted = await getWorker(stateDir, worker.workerId);
    expect(persisted?.workspace).toEqual(provisioned.workspace);
  });

  it("keeps worker edits isolated from the main working tree and retrying provisioning preserves worker HEAD", async () => {
    const { root, initialCommit } = await initRepository();
    const stateDir = await makeTempDir("chatgpt2codex-worker-state-");
    const worker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Create worker-only file",
    });
    const provisioned = await provisionWorkerWorktree(stateDir, root, worker.workerId);
    const worktreePath = provisioned.workspace!.worktreePath;

    await fs.writeFile(path.join(worktreePath, "worker.txt"), "worker-only\n", "utf8");
    await git(worktreePath, ["add", "worker.txt"]);
    await git(worktreePath, ["commit", "-m", "worker change"]);
    const workerHead = await git(worktreePath, ["rev-parse", "HEAD"]);

    expect(workerHead).not.toBe(initialCommit);
    await expect(fs.stat(path.join(root, "worker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(initialCommit);

    const retried = await provisionWorkerWorktree(stateDir, root, worker.workerId);
    expect(retried.workspace).toEqual(provisioned.workspace);
    expect((await verifyWorkerWorktree(stateDir, root, retried)).head).toBe(workerHead);
  });

  it("refuses destructive cleanup of a dirty worktree and preserves the branch after clean removal", async () => {
    const { root } = await initRepository();
    const stateDir = await makeTempDir("chatgpt2codex-worker-state-");
    const worker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Exercise safe cleanup",
    });
    const provisioned = await provisionWorkerWorktree(stateDir, root, worker.workerId);
    const worktreePath = provisioned.workspace!.worktreePath;

    await fs.writeFile(path.join(worktreePath, "unfinished.txt"), "do not delete\n", "utf8");
    await expect(removeWorkerWorktree(stateDir, root, worker.workerId)).rejects.toThrow();
    expect(await fs.readFile(path.join(worktreePath, "unfinished.txt"), "utf8")).toBe("do not delete\n");

    await fs.rm(path.join(worktreePath, "unfinished.txt"));
    const removed = await removeWorkerWorktree(stateDir, root, worker.workerId);
    expect(removed.removed).toBe(true);
    expect(removed.branchPreserved).toBe(true);
    await expect(fs.stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    const persisted = await getWorker(stateDir, worker.workerId);
    expect(persisted?.workspace?.removedAt).toEqual(expect.any(Number));
    expect(await git(root, ["show-ref", "--verify", `refs/heads/${workerBranch(worker.workerId)}`])).toContain(workerBranch(worker.workerId));
  });

  it("requires the supplied project path to be the actual Git repository root", async () => {
    const { root } = await initRepository();
    const stateDir = await makeTempDir("chatgpt2codex-worker-state-");
    const worker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Reject subdirectory roots",
    });
    const subdir = path.join(root, "src");
    await fs.mkdir(subdir);

    await expect(provisionWorkerWorktree(stateDir, subdir, worker.workerId)).rejects.toThrow(
      /must be the Git repository root/,
    );
    expect((await getWorker(stateDir, worker.workerId))?.workspace).toBeUndefined();
  });

  it("does not accept arbitrary worker ids as worktree selectors", async () => {
    const { root } = await initRepository();
    const stateDir = await makeTempDir("chatgpt2codex-worker-state-");
    await expect(provisionWorkerWorktree(stateDir, root, "../../main")).rejects.toThrow(/Invalid worker id/);
  });
});
