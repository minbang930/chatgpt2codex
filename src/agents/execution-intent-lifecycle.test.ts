import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  markBrowserWorkerFailed,
  type BrowserWorkerDriver,
  type BrowserWorkerLaunchInput,
} from "./browser-controller.js";
import { launchPreparedBrowserWorker, recoverRunningBrowserWorker } from "./browser-launch.js";
import { setWorkerExecutionPreference } from "./execution-settings.js";
import { getAgentStatus, spawnAgent } from "./manager.js";
import { createWorker, getWorker } from "./store.js";

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

async function makeGitProject(): Promise<string> {
  const root = await temp("chatgpt2codex-execution-intent-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Execution Intent Test"]);
  await git(root, ["config", "user.email", "execution-intent@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("durable worker execution intent", () => {
  it("resolves intent at spawn and keeps the same durable intent in initial launch and recovery", async () => {
    const stateDir = await temp("chatgpt2codex-execution-intent-state-");
    const root = await makeGitProject();
    const projectId = "project-execution-intent";

    await setWorkerExecutionPreference(stateDir, "global", {
      model: "gpt-global",
      reasoningEffort: "medium",
    });
    await setWorkerExecutionPreference(
      stateDir,
      "project",
      { reasoningEffort: "high" },
      projectId,
    );

    const worker = await spawnAgent(stateDir, {
      project: { projectId, root },
      task: "Keep this execution intent stable",
      execution: { model: "gpt-worker" },
    });

    const expectedIntent = {
      requested: { model: "gpt-worker" },
      resolved: {
        model: "gpt-worker",
        reasoningEffort: "high",
        fallbackPolicy: "fail-closed",
      },
      sources: {
        model: "worker",
        reasoningEffort: "project",
        fallbackPolicy: "default",
      },
    } as const;
    expect(worker.executionIntent).toEqual(expectedIntent);

    await setWorkerExecutionPreference(stateDir, "global", {
      model: "gpt-global-new",
      reasoningEffort: "instant",
      fallbackPolicy: "allow-current",
    });
    await setWorkerExecutionPreference(
      stateDir,
      "project",
      { reasoningEffort: "extra-high" },
      projectId,
    );

    expect((await getAgentStatus(stateDir, worker.workerId)).executionIntent).toEqual(expectedIntent);

    const launchInputs: BrowserWorkerLaunchInput[] = [];
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        launchInputs.push(input);
        return { browserHandle: `fake:execution-intent:${launchInputs.length}` };
      },
      cancel: async () => undefined,
    };
    const launched = await launchPreparedBrowserWorker(stateDir, driver, worker.workerId);
    expect(launched.worker.executionIntent).toEqual(expectedIntent);
    expect(launchInputs).toHaveLength(1);
    expect(launchInputs[0]?.executionIntent).toEqual(expectedIntent);

    await markBrowserWorkerFailed(stateDir, worker.workerId, "target lost");
    const recovered = await recoverRunningBrowserWorker(stateDir, driver, worker.workerId);
    expect(recovered.worker.executionIntent).toEqual(expectedIntent);
    expect(launchInputs).toHaveLength(2);
    expect(launchInputs[1]?.executionIntent).toEqual(expectedIntent);
    expect((await getAgentStatus(stateDir, worker.workerId)).executionIntent).toEqual(expectedIntent);
  });

  it("keeps workers without execution settings backward compatible", async () => {
    const stateDir = await temp("chatgpt2codex-execution-intent-legacy-");
    const worker = await createWorker(stateDir, {
      projectId: "project-legacy",
      task: "Use existing unmanaged ChatGPT execution state",
    });

    expect(worker.executionIntent).toBeUndefined();
    expect((await getWorker(stateDir, worker.workerId))?.executionIntent).toBeUndefined();
  });
});
