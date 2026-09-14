import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchPreparedBrowserWorker } from "./browser-launch.js";
import type { BrowserWorkerDriver, BrowserWorkerLaunchInput } from "./browser-controller.js";
import { verifyWorkerCapability } from "./capability.js";
import { assignWorkerWorkspace, cancelWorker, createWorker, getWorker } from "./store.js";

const tempDirs: string[] = [];

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-browser-launch-"));
  tempDirs.push(dir);
  return dir;
}

async function preparedWorker(dir: string) {
  const worker = await createWorker(dir, { projectId: "project-1", task: "Implement the worker task" });
  return assignWorkerWorkspace(dir, worker.workerId, {
    branch: `agent/${worker.workerId}`,
    worktreePath: path.join(dir, "worktree"),
    baseCommit: "a".repeat(40),
    createdAt: Date.now(),
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agents/browser-launch", () => {
  it("issues the raw capability only to the driver and marks the worker running after bootstrap success", async () => {
    const dir = await stateDir();
    const worker = await preparedWorker(dir);
    let launchInput: BrowserWorkerLaunchInput | undefined;
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        launchInput = input;
        return { browserHandle: "cdp:target-1" };
      },
      cancel: async () => undefined,
    };

    const outcome = await launchPreparedBrowserWorker(dir, driver, worker.workerId);
    expect(outcome.worker.status).toBe("running");
    expect(outcome.browser).toMatchObject({ status: "running", browserHandle: "cdp:target-1" });
    expect(outcome).not.toHaveProperty("workerToken");
    expect(outcome).not.toHaveProperty("token");
    expect(launchInput).toMatchObject({
      workerId: worker.workerId,
      projectId: "project-1",
      task: "Implement the worker task",
    });
    expect(launchInput?.workerToken).toMatch(/^wcap\./);
    await expect(verifyWorkerCapability(dir, String(launchInput?.workerToken))).resolves.toMatchObject({
      workerId: worker.workerId,
    });
  });

  it("keeps the durable worker pending and revokes the capability when browser bootstrap fails", async () => {
    const dir = await stateDir();
    const worker = await preparedWorker(dir);
    let issuedToken = "";
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        issuedToken = input.workerToken;
        throw new Error("ChatGPT composer unavailable");
      },
      cancel: async () => undefined,
    };

    await expect(launchPreparedBrowserWorker(dir, driver, worker.workerId)).rejects.toThrow(/composer unavailable/);
    expect((await getWorker(dir, worker.workerId))?.status).toBe("pending");
    await expect(verifyWorkerCapability(dir, issuedToken)).rejects.toThrow(/expired, revoked, or unknown/);
  });

  it("closes the launched browser and revokes its capability if the worker is cancelled before running transition", async () => {
    const dir = await stateDir();
    const worker = await preparedWorker(dir);
    let issuedToken = "";
    const cancelledHandles: string[] = [];
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        issuedToken = input.workerToken;
        await cancelWorker(dir, worker.workerId, "cancelled during launch");
        return { browserHandle: "cdp:race-target" };
      },
      cancel: async (input) => {
        if (input.browserHandle) cancelledHandles.push(input.browserHandle);
      },
    };

    await expect(launchPreparedBrowserWorker(dir, driver, worker.workerId)).rejects.toThrow(/already cancelled/);
    expect((await getWorker(dir, worker.workerId))?.status).toBe("cancelled");
    expect(cancelledHandles).toEqual(["cdp:race-target"]);
    await expect(verifyWorkerCapability(dir, issuedToken)).rejects.toThrow(/no longer active|revoked/);
  });
});
