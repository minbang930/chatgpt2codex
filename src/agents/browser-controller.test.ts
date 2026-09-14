import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserWorkerController,
  clearChatGptProjectMapping,
  getBrowserWorkerSession,
  getChatGptProjectMapping,
  prepareBrowserWorkerSession,
  resolveBrowserWorkerRoute,
  setChatGptProjectMapping,
  type BrowserWorkerDriver,
  type BrowserWorkerLaunchInput,
} from "./browser-controller.js";
import { createWorker, getWorker } from "./store.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agents/browser-controller", () => {
  it("stores an optional local-project to ChatGPT Project mapping with standalone fallback", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-browser-state-");

    expect(await resolveBrowserWorkerRoute(stateDir, "project-1")).toEqual({ mode: "standalone" });

    const mapping = await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-example/project#fragment",
      label: "Project One",
    });
    expect(mapping.projectRef).toEqual({
      url: "https://chatgpt.com/g/g-p-example/project",
      label: "Project One",
    });
    expect(await getChatGptProjectMapping(stateDir, "project-1")).toEqual(mapping);
    expect(await resolveBrowserWorkerRoute(stateDir, "project-1")).toEqual({
      mode: "project",
      projectRef: mapping.projectRef,
    });

    expect(await clearChatGptProjectMapping(stateDir, "project-1")).toBe(true);
    expect(await clearChatGptProjectMapping(stateDir, "project-1")).toBe(false);
    expect(await resolveBrowserWorkerRoute(stateDir, "project-1")).toEqual({ mode: "standalone" });
  });

  it("rejects non-ChatGPT routing URLs", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-browser-state-");
    await expect(
      setChatGptProjectMapping(stateDir, "project-1", { url: "https://example.com/project/123" }),
    ).rejects.toThrow(/ChatGPT Project URL/);
    await expect(
      setChatGptProjectMapping(stateDir, "project-1", { url: "http://chatgpt.com/project/123" }),
    ).rejects.toThrow(/ChatGPT Project URL/);
  });

  it("prepares a browser session only for the durable worker's assigned project", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-browser-state-");
    const worker = await createWorker(stateDir, { projectId: "project-1", task: "Do the task" });
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-example/project",
    });

    const session = await prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    });
    expect(session).toMatchObject({
      workerId: worker.workerId,
      projectId: "project-1",
      status: "prepared",
      attempt: 1,
      route: {
        mode: "project",
        projectRef: { url: "https://chatgpt.com/g/g-p-example/project" },
      },
    });

    await expect(
      prepareBrowserWorkerSession(stateDir, { workerId: worker.workerId, projectId: "project-2" }),
    ).rejects.toThrow(/bound to project project-1/);
    await expect(
      prepareBrowserWorkerSession(stateDir, {
        workerId: "wrk_00000000-0000-0000-0000-000000000000",
        projectId: "project-1",
      }),
    ).rejects.toThrow(/Worker not found/);
  });

  it("launches through the driver without persisting task or raw worker capability", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-browser-state-");
    const worker = await createWorker(stateDir, { projectId: "project-1", task: "Durable worker task" });
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-example/project",
      label: "Mapped Project",
    });

    let launchInput: BrowserWorkerLaunchInput | undefined;
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        launchInput = input;
        return { browserHandle: "tab-local-42" };
      },
      cancel: async () => undefined,
    };
    const controller = new BrowserWorkerController(stateDir, driver);
    const workerToken = "wcap.secret-capability-material";
    const task = "Implement a private worker task";

    const session = await controller.launch({
      workerId: worker.workerId,
      projectId: "project-1",
      task,
      workerToken,
    });

    expect(launchInput).toMatchObject({
      workerId: worker.workerId,
      projectId: "project-1",
      task,
      workerToken,
      route: {
        mode: "project",
        projectRef: { url: "https://chatgpt.com/g/g-p-example/project", label: "Mapped Project" },
      },
    });
    expect(session).toMatchObject({
      status: "running",
      browserHandle: "tab-local-42",
      attempt: 1,
    });

    const rawSession = await readFile(
      path.join(stateDir, "agents", "browser-sessions", `${worker.workerId}.json`),
      "utf8",
    );
    expect(rawSession).not.toContain(workerToken);
    expect(rawSession).not.toContain(task);
    expect((await getWorker(stateDir, worker.workerId))?.status).toBe("pending");
  });

  it("records browser launch failure without failing the durable coding worker and allows a new attempt", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-browser-state-");
    const worker = await createWorker(stateDir, { projectId: "project-1", task: "Keep durable state" });
    let launches = 0;
    const driver: BrowserWorkerDriver = {
      launch: async () => {
        launches += 1;
        if (launches === 1) throw new Error("browser unavailable");
        return { browserHandle: "tab-retry" };
      },
      cancel: async () => undefined,
    };
    const controller = new BrowserWorkerController(stateDir, driver);

    await expect(
      controller.launch({
        workerId: worker.workerId,
        projectId: "project-1",
        task: "Try once",
        workerToken: "wcap.retry-one",
      }),
    ).rejects.toThrow(/browser unavailable/);

    expect(await getBrowserWorkerSession(stateDir, worker.workerId)).toMatchObject({
      status: "failed",
      attempt: 1,
      lastError: "browser unavailable",
    });
    expect((await getWorker(stateDir, worker.workerId))?.status).toBe("pending");

    const retried = await controller.launch({
      workerId: worker.workerId,
      projectId: "project-1",
      task: "Try again",
      workerToken: "wcap.retry-two",
    });
    expect(retried).toMatchObject({ status: "running", attempt: 2, browserHandle: "tab-retry" });
    expect((await getWorker(stateDir, worker.workerId))?.status).toBe("pending");
  });

  it("cancels only browser state through the driver", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-browser-state-");
    const worker = await createWorker(stateDir, { projectId: "project-1", task: "Cancelable" });
    const cancelled: Array<{ workerId: string; browserHandle?: string }> = [];
    const driver: BrowserWorkerDriver = {
      launch: async () => ({ browserHandle: "tab-cancel" }),
      cancel: async (input) => {
        cancelled.push(input);
      },
    };
    const controller = new BrowserWorkerController(stateDir, driver);
    await controller.launch({
      workerId: worker.workerId,
      projectId: "project-1",
      task: "Launch",
      workerToken: "wcap.cancel",
    });

    const session = await controller.cancel(worker.workerId);
    expect(cancelled).toEqual([{ workerId: worker.workerId, browserHandle: "tab-cancel" }]);
    expect(session.status).toBe("stopped");
    expect((await getWorker(stateDir, worker.workerId))?.status).toBe("pending");
  });
});
