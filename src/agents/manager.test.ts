import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeAgentEvent,
  cancelAgent,
  getAgentResult,
  getAgentStatus,
  getAgentWorkspace,
  spawnAgent,
  waitForAgentEvents,
} from "./manager.js";
import { completeWorker, markWorkerRunning } from "./store.js";

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

async function makeGitProject(): Promise<{ root: string; initialCommit: string }> {
  const root = await makeTempDir("chatgpt2codex-manager-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Agent Manager Test"]);
  await git(root, ["config", "user.email", "agent-manager@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return { root, initialCommit: await git(root, ["rev-parse", "HEAD"]) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agents/manager", () => {
  it("spawns a pending worker with an isolated managed worktree", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-manager-state-");
    const project = await makeGitProject();

    const worker = await spawnAgent(stateDir, {
      project: { projectId: "project-1", root: project.root },
      task: "Implement the worker task",
    });

    expect(worker.status).toBe("pending");
    expect(worker.workspace?.branch).toBe(`agent/${worker.workerId}`);
    expect(worker.workspace?.baseCommit).toBe(project.initialCommit);
    expect(worker.workspace?.worktreePath.startsWith(stateDir)).toBe(true);
    expect(await stat(worker.workspace!.worktreePath)).toBeTruthy();

    const workspace = await getAgentWorkspace(stateDir, project.root, worker.workerId);
    expect(workspace.branch).toBe(worker.workspace?.branch);
    expect(workspace.head).toBe(project.initialCommit);
    expect(await getAgentStatus(stateDir, worker.workerId)).toEqual(worker);
  });

  it("retrieves a durable completed result", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-manager-state-");
    const project = await makeGitProject();
    const worker = await spawnAgent(stateDir, {
      project: { projectId: "project-1", root: project.root },
      task: "Finish and report",
    });

    await markWorkerRunning(stateDir, worker.workerId);
    await completeWorker(stateDir, worker.workerId, {
      summary: "Implemented the change",
      commitSha: project.initialCommit,
      changedFiles: ["README.md"],
      checks: ["tests passed"],
      remainingIssues: [],
    });

    expect(await getAgentResult(stateDir, worker.workerId)).toEqual({
      workerId: worker.workerId,
      status: "completed",
      result: {
        summary: "Implemented the change",
        commitSha: project.initialCommit,
        changedFiles: ["README.md"],
        checks: ["tests passed"],
        remainingIssues: [],
      },
      error: undefined,
    });
  });

  it("cancels without deleting partial worker edits or its worktree", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-manager-state-");
    const project = await makeGitProject();
    const worker = await spawnAgent(stateDir, {
      project: { projectId: "project-1", root: project.root },
      task: "Make a partial edit",
    });

    const workerFile = path.join(worker.workspace!.worktreePath, "worker.txt");
    await writeFile(workerFile, "partial work\n", "utf8");

    const cancelled = await cancelAgent(stateDir, worker.workerId, "stop requested");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("stop requested");
    expect(cancelled.workspace?.removedAt).toBeUndefined();
    expect(await readFile(workerFile, "utf8")).toBe("partial work\n");
  });

  it("waits for a worker event, leaves it unacknowledged, then acknowledges it explicitly", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-manager-state-");
    const project = await makeGitProject();
    const worker = await spawnAgent(stateDir, {
      project: { projectId: "project-1", root: project.root },
      task: "Complete asynchronously",
    });

    const waitPromise = waitForAgentEvents(stateDir, {
      workerIds: [worker.workerId],
      timeoutMs: 2_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    const completed = await completeWorker(stateDir, worker.workerId, { summary: "Done" });

    const waited = await waitPromise;
    expect(waited.timedOut).toBe(false);
    expect(waited.events).toHaveLength(1);
    expect(waited.events[0]?.worker.workerId).toBe(worker.workerId);
    expect(waited.events[0]?.notification.eventId).toBe(completed.notification?.eventId);

    const stillVisible = await waitForAgentEvents(stateDir, {
      workerIds: [worker.workerId],
      timeoutMs: 0,
    });
    expect(stillVisible.events).toHaveLength(1);

    await acknowledgeAgentEvent(stateDir, completed.notification!.eventId);
    const afterAck = await waitForAgentEvents(stateDir, {
      workerIds: [worker.workerId],
      timeoutMs: 0,
    });
    expect(afterAck).toEqual({ timedOut: true, events: [] });
    expect((await getAgentResult(stateDir, worker.workerId)).result?.summary).toBe("Done");
  });

  it("times out cleanly and validates wait bounds/worker ids", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-manager-state-");
    const project = await makeGitProject();
    const worker = await spawnAgent(stateDir, {
      project: { projectId: "project-1", root: project.root },
      task: "Keep waiting",
    });

    expect(await waitForAgentEvents(stateDir, { workerIds: [worker.workerId], timeoutMs: 20 })).toEqual({
      timedOut: true,
      events: [],
    });
    await expect(waitForAgentEvents(stateDir, { timeoutMs: 60_001 })).rejects.toThrow(/between 0 and 60000/);
    await expect(waitForAgentEvents(stateDir, { workerIds: ["wrk_00000000-0000-0000-0000-000000000000"], timeoutMs: 0 })).rejects.toThrow(/Worker not found/);
  });
});
