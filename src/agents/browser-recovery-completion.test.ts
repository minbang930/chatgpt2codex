import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserWorkerDriver } from "./browser-controller.js";
import { getBrowserWorkerSession } from "./browser-controller.js";
import { launchPreparedBrowserWorker, recoverRunningBrowserWorker } from "./browser-launch.js";
import { reconcileBrowserWorker } from "./browser-recovery.js";
import { verifyWorkerCapability } from "./capability.js";
import { getAgentStatus, spawnAgent } from "./manager.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeWorker(task = "Finish the assigned change"): Promise<{
  stateDir: string;
  workerId: string;
  originalToken: () => string;
  driver: BrowserWorkerDriver;
}> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-dom-fallback-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-dom-fallback-project-"));
  tempDirs.push(stateDir, root);
  const git = async (args: string[]) => (await execFileAsync("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git(["init"]);
  await git(["config", "user.name", "DOM Fallback Test"]);
  await git(["config", "user.email", "dom-fallback@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);

  const worker = await spawnAgent(stateDir, {
    project: { projectId: "project-dom-fallback", root },
    task,
  });
  let token = "";
  const driver: BrowserWorkerDriver = {
    launch: async (input) => {
      token = input.workerToken;
      return { browserHandle: "cdp:dom-fallback-target" };
    },
    cancel: async () => undefined,
  };
  await launchPreparedBrowserWorker(stateDir, driver, worker.workerId);
  return { stateDir, workerId: worker.workerId, originalToken: () => token, driver };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("browser completion fallback", () => {
  it("keeps the durable worker recoverable when ChatGPT becomes idle without worker_finish", async () => {
    const setup = await makeWorker();
    const originalToken = setup.originalToken();
    expect(await verifyWorkerCapability(setup.stateDir, originalToken)).toMatchObject({ workerId: setup.workerId });

    const browser = await reconcileBrowserWorker(
      setup.stateDir,
      setup.workerId,
      { isAlive: async () => true },
      {
        inspect: async () => ({
          state: "idle",
          assistantText: "I changed the requested files but forgot to call worker_finish.",
        }),
      },
    );

    expect(browser).toMatchObject({ status: "failed", attempt: 1 });
    expect(browser?.lastError).toContain("without worker_finish");
    expect(browser?.lastError).toContain("I changed the requested files");
    expect((await getAgentStatus(setup.stateDir, setup.workerId)).status).toBe("running");
    await expect(verifyWorkerCapability(setup.stateDir, originalToken)).rejects.toThrow();

    let recoveredToken = "";
    const recovered = await recoverRunningBrowserWorker(setup.stateDir, {
      launch: async (input) => {
        recoveredToken = input.workerToken;
        return { browserHandle: "cdp:dom-fallback-recovered" };
      },
      cancel: async () => undefined,
    }, setup.workerId);

    expect(recovered.worker.status).toBe("running");
    expect(recovered.browser).toMatchObject({ status: "running", attempt: 2 });
    expect(recoveredToken).not.toBe(originalToken);
    expect(await verifyWorkerCapability(setup.stateDir, recoveredToken)).toMatchObject({ workerId: setup.workerId });
  });

  it("does not disturb a worker that is still generating", async () => {
    const setup = await makeWorker("Keep working");
    const token = setup.originalToken();

    const browser = await reconcileBrowserWorker(
      setup.stateDir,
      setup.workerId,
      { isAlive: async () => true },
      { inspect: async () => ({ state: "generating" }) },
    );

    expect(browser).toMatchObject({ status: "running", attempt: 1 });
    expect((await getBrowserWorkerSession(setup.stateDir, setup.workerId))?.status).toBe("running");
    expect((await getAgentStatus(setup.stateDir, setup.workerId)).status).toBe("running");
    expect(await verifyWorkerCapability(setup.stateDir, token)).toMatchObject({ workerId: setup.workerId });
  });

  it("ignores DOM probe errors rather than failing a healthy worker", async () => {
    const setup = await makeWorker("Ignore observer breakage");
    const token = setup.originalToken();

    const browser = await reconcileBrowserWorker(
      setup.stateDir,
      setup.workerId,
      { isAlive: async () => true },
      { inspect: async () => { throw new Error("selector changed"); } },
    );

    expect(browser).toMatchObject({ status: "running", attempt: 1 });
    expect(await verifyWorkerCapability(setup.stateDir, token)).toMatchObject({ workerId: setup.workerId });
  });
});
