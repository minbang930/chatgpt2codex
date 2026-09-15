import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignWorkerWorkspace,
  cancelWorker,
  completeWorker,
  createWorker,
  getWorker,
  markWorkerRunning,
} from "../agents/store.js";

const roots: string[] = [];

async function makeFixture(): Promise<{
  root: string;
  stateDir: string;
  worktreePath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-subagent-hooks-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const worktreePath = path.join(root, "worker-worktree");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(worktreePath, { recursive: true })]);
  return { root, stateDir, worktreePath };
}

async function writeConfig(
  stateDir: string,
  hooks: Record<string, Array<Record<string, unknown>>>,
): Promise<void> {
  await writeFile(path.join(stateDir, "hooks.json"), JSON.stringify({ version: 1, hooks }, null, 2), "utf8");
}

async function createAssignedWorker(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  task = "sensitive worker task must stay out of hooks",
) {
  const worker = await createWorker(fixture.stateDir, { projectId: "project-1", task });
  return assignWorkerWorkspace(fixture.stateDir, worker.workerId, {
    branch: `worker/${worker.workerId}`,
    worktreePath: fixture.worktreePath,
    baseCommit: "a".repeat(40),
    createdAt: Date.now(),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("subagent lifecycle hooks", () => {
  it("emits exactly one start and one stop from durable state transitions", async () => {
    const fixture = await makeFixture();
    const marker = path.join(fixture.root, "events.jsonl");
    const script = path.join(fixture.root, "capture.mjs");
    await writeFile(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        "let input = ''; process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { const e = JSON.parse(input);",
        `  appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: e.event, payload: e.payload, cwd: process.cwd() }) + '\\n'); });`,
      ].join("\n"),
      "utf8",
    );
    const hook = {
      id: "capture-subagent",
      type: "command",
      command: process.execPath,
      args: [script],
      cwd: "project",
    };
    await writeConfig(fixture.stateDir, { SubagentStart: [hook], SubagentStop: [hook] });

    const worker = await createAssignedWorker(fixture);
    const running = await markWorkerRunning(fixture.stateDir, worker.workerId);
    expect(running.status).toBe("running");
    await markWorkerRunning(fixture.stateDir, worker.workerId);

    const completed = await completeWorker(fixture.stateDir, worker.workerId, {
      summary: "sensitive completion summary must stay out of hooks",
    });
    expect(completed.status).toBe("completed");
    await completeWorker(fixture.stateDir, worker.workerId, { summary: "ignored duplicate completion" });

    const events = (await readFile(marker, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; payload: Record<string, unknown>; cwd: string });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(
      expect.objectContaining({
        event: "SubagentStart",
        payload: {
          workerId: worker.workerId,
          projectId: "project-1",
          status: "running",
        },
      }),
    );
    expect(events[1]).toEqual(
      expect.objectContaining({
        event: "SubagentStop",
        payload: {
          workerId: worker.workerId,
          projectId: "project-1",
          status: "completed",
        },
      }),
    );
    expect(await realpath(events[0]?.cwd ?? "")).toBe(await realpath(fixture.worktreePath));
    expect(await realpath(events[1]?.cwd ?? "")).toBe(await realpath(fixture.worktreePath));
    expect(JSON.stringify(events)).not.toContain("sensitive worker task");
    expect(JSON.stringify(events)).not.toContain("sensitive completion summary");
  });

  it("emits SubagentStop for a pending worker cancelled before launch", async () => {
    const fixture = await makeFixture();
    const marker = path.join(fixture.root, "stop.txt");
    const script = path.join(fixture.root, "stop.mjs");
    await writeFile(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        "let input = ''; process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { const e = JSON.parse(input);",
        `  appendFileSync(${JSON.stringify(marker)}, e.event + ':' + e.payload.status + '\\n'); });`,
      ].join("\n"),
      "utf8",
    );
    await writeConfig(fixture.stateDir, {
      SubagentStop: [{ id: "pending-stop", type: "command", command: process.execPath, args: [script] }],
    });

    const worker = await createAssignedWorker(fixture, "cancel before browser launch");
    const cancelled = await cancelWorker(fixture.stateDir, worker.workerId, "operator cancelled");

    expect(cancelled.status).toBe("cancelled");
    expect(await readFile(marker, "utf8")).toBe("SubagentStop:cancelled\n");
  });

  it("never lets failing lifecycle hooks roll back durable worker state", async () => {
    const fixture = await makeFixture();
    const failing = {
      id: "fails",
      type: "command",
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    };
    await writeConfig(fixture.stateDir, { SubagentStart: [failing], SubagentStop: [failing] });

    const worker = await createAssignedWorker(fixture);
    await expect(markWorkerRunning(fixture.stateDir, worker.workerId)).resolves.toMatchObject({ status: "running" });
    await expect(cancelWorker(fixture.stateDir, worker.workerId, "stop now")).resolves.toMatchObject({ status: "cancelled" });

    expect(await getWorker(fixture.stateDir, worker.workerId)).toMatchObject({ status: "cancelled" });
  });
});
