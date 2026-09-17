import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBrowserWorkerSession, setChatGptProjectMapping } from "./browser-controller.js";
import { spawnAgent } from "./manager.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const originalFixedProjectUrl = process.env.CHATGPT2CODEX_WORKER_PROJECT_URL;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function makeGitProject(): Promise<string> {
  const root = await makeTempDir("chatgpt2codex-placement-project-");
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Placement Test"]);
  await git(root, ["config", "user.email", "placement@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

afterEach(async () => {
  if (originalFixedProjectUrl === undefined) {
    delete process.env.CHATGPT2CODEX_WORKER_PROJECT_URL;
  } else {
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = originalFixedProjectUrl;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent worker placement", () => {
  it("pins a per-worker project request at spawn time when no fixed EXE route exists", async () => {
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "";
    const stateDir = await makeTempDir("chatgpt2codex-placement-state-");
    const root = await makeGitProject();
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-mapped/project",
    });

    const worker = await spawnAgent(stateDir, {
      project: { projectId: "project-1", root },
      task: "Use requested placement",
      placement: {
        mode: "project",
        projectRef: { url: "https://chatgpt.com/g/g-p-requested/project#fragment" },
      },
    });

    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-later/project",
    });
    expect((await prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    })).route).toEqual({
      mode: "project",
      projectRef: { url: "https://chatgpt.com/g/g-p-requested/project" },
    });
  });

  it("pins an explicit standalone request even when a project mapping exists", async () => {
    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "";
    const stateDir = await makeTempDir("chatgpt2codex-placement-state-");
    const root = await makeGitProject();
    await setChatGptProjectMapping(stateDir, "project-1", {
      url: "https://chatgpt.com/g/g-p-mapped/project",
    });

    const worker = await spawnAgent(stateDir, {
      project: { projectId: "project-1", root },
      task: "Use standalone placement",
      placement: { mode: "standalone" },
    });
    expect((await prepareBrowserWorkerSession(stateDir, {
      workerId: worker.workerId,
      projectId: "project-1",
    })).route).toEqual({ mode: "standalone" });
  });
});
