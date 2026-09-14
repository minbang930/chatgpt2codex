import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cancelWorker,
  completeWorker,
  createWorker,
  failWorker,
  getWorker,
  listUnnotifiedWorkerEvents,
  listWorkers,
  markWorkerEventNotified,
  markWorkerRunning,
} from "./store.js";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-agents-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agents/store", () => {
  it("creates and persists a pending worker", async () => {
    const stateDir = await makeStateDir();
    const created = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Implement the migration",
    });

    expect(created.workerId).toMatch(/^wrk_[0-9a-f-]{36}$/i);
    expect(created.status).toBe("pending");
    expect(created.projectId).toBe("project-1");
    expect(created.task).toBe("Implement the migration");

    const loaded = await getWorker(stateDir, created.workerId);
    expect(loaded).toEqual(created);
    expect(await listWorkers(stateDir)).toEqual([created]);
  });

  it("moves a worker through running to completed and creates one durable completion notification", async () => {
    const stateDir = await makeStateDir();
    const created = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Implement worker storage",
    });

    const running = await markWorkerRunning(stateDir, created.workerId);
    expect(running.status).toBe("running");
    expect(running.startedAt).toEqual(expect.any(Number));

    const completed = await completeWorker(stateDir, created.workerId, {
      summary: "Worker storage implemented",
      commitSha: "abc123",
      changedFiles: ["src/agents/store.ts"],
      checks: ["vitest passed"],
      remainingIssues: [],
    });

    expect(completed.status).toBe("completed");
    expect(completed.finishedAt).toEqual(expect.any(Number));
    expect(completed.result?.commitSha).toBe("abc123");
    expect(completed.notification?.status).toBe("completed");
    expect(completed.notification?.eventId).toMatch(/^evt_[0-9a-f-]{36}$/i);

    const events = await listUnnotifiedWorkerEvents(stateDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.worker.workerId).toBe(created.workerId);
    expect(events[0]?.notification.eventId).toBe(completed.notification?.eventId);

    const completedAgain = await completeWorker(stateDir, created.workerId, {
      summary: "A retry must not create another event",
    });
    expect(completedAgain.notification?.eventId).toBe(completed.notification?.eventId);
    expect(await listUnnotifiedWorkerEvents(stateDir)).toHaveLength(1);
  });

  it("marks a completion notification as delivered without discarding the worker result", async () => {
    const stateDir = await makeStateDir();
    const worker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Finish something",
    });
    const completed = await completeWorker(stateDir, worker.workerId, {
      summary: "Done",
      changedFiles: ["a.ts"],
    });
    const eventId = completed.notification?.eventId;
    expect(eventId).toBeTruthy();

    const marked = await markWorkerEventNotified(stateDir, eventId!, 123456789);
    expect(marked?.notification?.notifiedAt).toBe(123456789);
    expect(await listUnnotifiedWorkerEvents(stateDir)).toEqual([]);

    const loaded = await getWorker(stateDir, worker.workerId);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.result?.summary).toBe("Done");
    expect(loaded?.result?.changedFiles).toEqual(["a.ts"]);
  });

  it("records failed and cancelled workers as final inbox events", async () => {
    const stateDir = await makeStateDir();
    const failedWorker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Fail this worker",
    });
    const cancelledWorker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Cancel this worker",
    });

    const failed = await failWorker(stateDir, failedWorker.workerId, "browser closed");
    const cancelled = await cancelWorker(stateDir, cancelledWorker.workerId, "user cancelled");

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("browser closed");
    expect(failed.notification?.status).toBe("failed");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("user cancelled");
    expect(cancelled.notification?.status).toBe("cancelled");

    const events = await listUnnotifiedWorkerEvents(stateDir);
    expect(events.map((event) => event.notification.status).sort()).toEqual(["cancelled", "failed"]);
  });

  it("rejects empty creation inputs and never treats traversal strings as worker or event ids", async () => {
    const stateDir = await makeStateDir();

    await expect(createWorker(stateDir, { projectId: "", task: "task" })).rejects.toThrow();
    await expect(createWorker(stateDir, { projectId: "project-1", task: "   " })).rejects.toThrow();
    expect(await getWorker(stateDir, "../../sessions")).toBeNull();
    expect(await markWorkerEventNotified(stateDir, "../evt_bad")).toBeNull();
  });

  it("does not allow a final worker to transition back to running or to a different final status", async () => {
    const stateDir = await makeStateDir();
    const worker = await createWorker(stateDir, {
      projectId: "project-1",
      task: "Complete once",
    });
    await completeWorker(stateDir, worker.workerId, { summary: "Done" });

    await expect(markWorkerRunning(stateDir, worker.workerId)).rejects.toThrow(/already completed/);
    await expect(failWorker(stateDir, worker.workerId, "too late")).rejects.toThrow(/already completed/);
  });
});
