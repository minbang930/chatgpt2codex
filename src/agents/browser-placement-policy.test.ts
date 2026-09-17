import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markBrowserWorkerFailed,
  markBrowserWorkerLaunching,
  pinBrowserWorkerPlacement,
  prepareBrowserWorkerSession,
  setChatGptProjectMapping,
} from "./browser-controller.js";
import { createWorker } from "./store.js";

const tempDirs: string[] = [];
const originalFixedProjectUrl = process.env.CHATGPT2CODEX_WORKER_PROJECT_URL;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (originalFixedProjectUrl === undefined) {
    delete process.env.CHATGPT2CODEX_WORKER_PROJECT_URL;
  } else {
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = originalFixedProjectUrl;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("browser worker placement policy", () => {
  it("uses the fixed EXE/runtime project URL ahead of a project mapping and pins it across recovery", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-placement-state-");
    const worker = await createWorker(stateDir, { projectId: "project-1", task: "Pinned placement" });
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-mapped/project",
    });
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "https://chatgpt.com/g/g-p-fixed/project#fragment";
    await pinBrowserWorkerPlacement(stateDir, worker.workerId, "project-1", {
      mode: "project",
      projectRef: { url: "https://chatgpt.com/g/g-p-worker-request/project" },
    });

    const first = await prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    });
    expect(first.route).toEqual({
      mode: "project",
      projectRef: { url: "https://chatgpt.com/g/g-p-fixed/project" },
    });

    await markBrowserWorkerLaunching(stateDir, worker.workerId);
    await markBrowserWorkerFailed(stateDir, worker.workerId, "target lost");
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "https://chatgpt.com/g/g-p-changed/project";
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-mapped-changed/project",
    });

    const recovered = await prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    });
    expect(recovered.attempt).toBe(2);
    expect(recovered.route).toEqual(first.route);
  });

  it("uses project mapping or standalone routing when the fixed setting is blank", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-placement-state-");
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "";
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-mapped/project",
    });

    const mappedWorker = await createWorker(stateDir, { projectId: "project-1", task: "Mapped" });
    const standaloneWorker = await createWorker(stateDir, { projectId: "project-2", task: "Standalone" });

    expect((await prepareBrowserWorkerSession(stateDir, {
      workerId: mappedWorker.workerId,
      projectId: "project-1",
    })).route).toEqual({
      mode: "project",
      projectRef: { url: "https://chatgpt.com/g/g-p-mapped/project" },
    });
    expect((await prepareBrowserWorkerSession(stateDir, {
      workerId: standaloneWorker.workerId,
      projectId: "project-2",
    })).route).toEqual({ mode: "standalone" });
  });

  it("keeps a pre-policy browser session route when recovering an older worker", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-placement-state-");
    delete process.env.CHATGPT2CODEX_WORKER_PROJECT_URL;
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-original/project",
    });
    const worker = await createWorker(stateDir, { projectId: "project-1", task: "Legacy recovery" });
    const first = await prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    });
    await markBrowserWorkerLaunching(stateDir, worker.workerId);
    await markBrowserWorkerFailed(stateDir, worker.workerId, "target lost");

    await rm(path.join(stateDir, "agents", "browser-placements", `${worker.workerId}.json`), { force: true });
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "https://chatgpt.com/g/g-p-new-fixed/project";

    const recovered = await prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    });
    expect(recovered.route).toEqual(first.route);
  });

  it("rejects an invalid fixed Worker Project URL before browser launch", async () => {
    const stateDir = await makeTempDir("chatgpt2codex-placement-state-");
    const worker = await createWorker(stateDir, { projectId: "project-1", task: "Invalid fixed route" });
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "https://example.com/not-chatgpt";

    await expect(prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    })).rejects.toThrow(/ChatGPT Project URL/);
  });
});
