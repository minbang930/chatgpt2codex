import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateSkillName } from "../skills/activation.js";
import { globalSkillsDir } from "../skills/registry.js";
import { launchPreparedBrowserWorker, recoverRunningBrowserWorker } from "./browser-launch.js";
import {
  markBrowserWorkerFailed,
  type BrowserWorkerDriver,
  type BrowserWorkerLaunchInput,
} from "./browser-controller.js";
import { verifyWorkerCapability } from "./capability.js";
import { assignWorkerWorkspace, cancelWorker, createWorker, getWorker } from "./store.js";

const tempDirs: string[] = [];

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-browser-launch-"));
  tempDirs.push(dir);
  return dir;
}

async function preparedWorker(dir: string, task = "Implement the worker task") {
  const worker = await createWorker(dir, { projectId: "project-1", task });
  return assignWorkerWorkspace(dir, worker.workerId, {
    branch: `agent/${worker.workerId}`,
    worktreePath: path.join(dir, "worktree"),
    baseCommit: "a".repeat(40),
    createdAt: Date.now(),
  });
}

async function installGlobalSkill(dir: string, name: string, body: string): Promise<void> {
  const skillDir = path.join(globalSkillsDir(dir), name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} worker instructions\n---\n\n${body}\n`,
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agents/browser-launch", () => {
  it("issues the raw capability only to the driver and applies default FULL Ponytail policy after bootstrap success", async () => {
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
    });
    expect(launchInput?.task).toContain("Ponytail coding policy (FULL)");
    expect(launchInput?.task).toContain("Implement the worker task");
    expect(launchInput?.workerToken).toMatch(/^wcap\./);
    await expect(verifyWorkerCapability(dir, String(launchInput?.workerToken))).resolves.toMatchObject({
      workerId: worker.workerId,
    });
  });

  it("adds explicitly activated skills only to launch-time worker instructions and preserves the durable task", async () => {
    const dir = await stateDir();
    const rawTask = "Implement the parser edge case";
    const worker = await preparedWorker(dir, rawTask);
    await installGlobalSkill(dir, "reviewer", "CHECK THE PARSER EDGE CASE CAREFULLY.");
    await activateSkillName({
      stateDir: dir,
      name: "reviewer",
      activationScope: "global",
      projectId: "project-1",
    });

    let launchInput: BrowserWorkerLaunchInput | undefined;
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        launchInput = input;
        return { browserHandle: "cdp:target-skill" };
      },
      cancel: async () => undefined,
    };

    await launchPreparedBrowserWorker(dir, driver, worker.workerId);
    expect(launchInput?.task).toContain("Ponytail coding policy (FULL)");
    expect(launchInput?.task).toContain("Implement the parser edge case");
    expect(launchInput?.task).toContain("Additional activated Agent Skill instructions");
    expect(launchInput?.task).toContain("CHECK THE PARSER EDGE CASE CAREFULLY.");
    expect(launchInput?.task).toContain("do not grant extra tools, permissions, or capabilities");
    expect((await getWorker(dir, worker.workerId))?.task).toBe(rawTask);
  });

  it("re-applies current activated skill context when recovering the same durable running worker", async () => {
    const dir = await stateDir();
    const rawTask = "Repair the durable worker flow";
    const worker = await preparedWorker(dir, rawTask);
    await installGlobalSkill(dir, "recovery-helper", "RECOVERY SKILL CONTEXT.");
    await activateSkillName({
      stateDir: dir,
      name: "recovery-helper",
      activationScope: "global",
      projectId: "project-1",
    });

    const initialDriver: BrowserWorkerDriver = {
      launch: async () => ({ browserHandle: "cdp:target-initial" }),
      cancel: async () => undefined,
    };
    await launchPreparedBrowserWorker(dir, initialDriver, worker.workerId);
    await markBrowserWorkerFailed(dir, worker.workerId, "target lost");

    let recoveryInput: BrowserWorkerLaunchInput | undefined;
    const recoveryDriver: BrowserWorkerDriver = {
      launch: async (input) => {
        recoveryInput = input;
        return { browserHandle: "cdp:target-recovered" };
      },
      cancel: async () => undefined,
    };
    const outcome = await recoverRunningBrowserWorker(dir, recoveryDriver, worker.workerId);

    expect(outcome.worker.status).toBe("running");
    expect(recoveryInput?.task).toContain("RECOVERY SKILL CONTEXT.");
    expect(recoveryInput?.task).toContain(rawTask);
    expect((await getWorker(dir, worker.workerId))?.task).toBe(rawTask);
  });

  it("honors a task-local Ponytail OFF directive without persisting a rewritten durable task", async () => {
    const dir = await stateDir();
    const rawTask = "/ponytail off\nImplement exactly the requested compatibility shim";
    const worker = await preparedWorker(dir, rawTask);
    let launchInput: BrowserWorkerLaunchInput | undefined;
    const driver: BrowserWorkerDriver = {
      launch: async (input) => {
        launchInput = input;
        return { browserHandle: "cdp:target-off" };
      },
      cancel: async () => undefined,
    };

    await launchPreparedBrowserWorker(dir, driver, worker.workerId);
    expect(launchInput?.task).toBe("Implement exactly the requested compatibility shim");
    expect((await getWorker(dir, worker.workerId))?.task).toBe(rawTask);
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
