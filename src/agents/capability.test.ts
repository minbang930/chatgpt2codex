import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { completeWorker } from "./store.js";
import { spawnAgent } from "./manager.js";
import { issueWorkerCapability, revokeWorkerCapability, verifyWorkerCapability } from "./capability.js";

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

async function project(): Promise<string> {
  const root = await temp("chatgpt2codex-capability-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Capability Test"]);
  await git(root, ["config", "user.email", "capability@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function workerFixture() {
  const stateDir = await temp("chatgpt2codex-capability-state-");
  const root = await project();
  const worker = await spawnAgent(stateDir, {
    project: { projectId: "project-1", root },
    task: "Capability test worker",
  });
  return { stateDir, root, worker };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker capability", () => {
  it("stores only a hash, verifies the issued token, and rejects malformed tokens", async () => {
    const { stateDir, worker } = await workerFixture();
    const issued = await issueWorkerCapability(stateDir, worker.workerId);

    expect(issued.token).toMatch(new RegExp(`^wcap\\.${worker.workerId}\\.`));
    expect(await verifyWorkerCapability(stateDir, issued.token)).toMatchObject({ workerId: worker.workerId });

    const persisted = await readFile(path.join(stateDir, "agents", "capabilities", `${worker.workerId}.json`), "utf8");
    expect(persisted).not.toContain(issued.token);
    expect(persisted).toMatch(/"tokenHash": "[0-9a-f]{64}"/);

    await expect(verifyWorkerCapability(stateDir, "wcap.bad.token")).rejects.toThrow(/Invalid worker capability/);
  });

  it("reissuing invalidates the old token and revoke invalidates the new token", async () => {
    const { stateDir, worker } = await workerFixture();
    const first = await issueWorkerCapability(stateDir, worker.workerId);
    const second = await issueWorkerCapability(stateDir, worker.workerId);

    await expect(verifyWorkerCapability(stateDir, first.token)).rejects.toThrow(/does not match/);
    expect(await verifyWorkerCapability(stateDir, second.token)).toMatchObject({ workerId: worker.workerId });

    expect(await revokeWorkerCapability(stateDir, worker.workerId)).toBe(true);
    await expect(verifyWorkerCapability(stateDir, second.token)).rejects.toThrow(/expired, revoked, or unknown/);
  });

  it("does not issue or accept capabilities after the worker is final", async () => {
    const { stateDir, worker } = await workerFixture();
    const issued = await issueWorkerCapability(stateDir, worker.workerId);
    await completeWorker(stateDir, worker.workerId, { summary: "finished" });

    await expect(verifyWorkerCapability(stateDir, issued.token)).rejects.toThrow(/no longer active/);
    await expect(issueWorkerCapability(stateDir, worker.workerId)).rejects.toThrow(/completed worker/);
  });

  it("validates capability TTL bounds", async () => {
    const { stateDir, worker } = await workerFixture();
    await expect(issueWorkerCapability(stateDir, worker.workerId, 0)).rejects.toThrow(/TTL/);
    await expect(issueWorkerCapability(stateDir, worker.workerId, 24 * 60 * 60 * 1000 + 1)).rejects.toThrow(/TTL/);
  });
});
