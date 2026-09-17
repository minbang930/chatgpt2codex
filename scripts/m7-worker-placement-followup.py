from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one target, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


browser = "src/agents/browser-controller.ts"
replace_once(
    browser,
    '  source: "fixed" | "mapping" | "standalone" | "legacy-session";',
    '  source: "fixed" | "worker-project" | "worker-standalone" | "mapping" | "standalone" | "legacy-session";',
)
replace_once(
    browser,
    '  source: z.enum(["fixed", "mapping", "standalone", "legacy-session"]),',
    '  source: z.enum(["fixed", "worker-project", "worker-standalone", "mapping", "standalone", "legacy-session"]),',
)
replace_once(
    browser,
    '''async function resolveDurableBrowserWorkerRoute(
  stateDir: string,
  workerId: string,
  projectId: string,
  legacyRoute?: BrowserWorkerRoute,
): Promise<BrowserWorkerRoute> {''',
    '''export async function pinBrowserWorkerPlacement(
  stateDir: string,
  workerId: string,
  projectId: string,
  requestedRoute?: BrowserWorkerRoute,
  legacyRoute?: BrowserWorkerRoute,
): Promise<BrowserWorkerRoute> {''',
)
replace_once(
    browser,
    '''    } else {
      const mapping = await getChatGptProjectMapping(stateDir, projectId);
      if (mapping) {
        route = { mode: "project", projectRef: mapping.projectRef };
        source = "mapping";
      } else {
        route = { mode: "standalone" };
        source = "standalone";
      }
    }
  }
''',
    '''    } else if (requestedRoute) {
      if (requestedRoute.mode === "project") {
        route = { mode: "project", projectRef: normalizeProjectRef(requestedRoute.projectRef) };
        source = "worker-project";
      } else {
        route = { mode: "standalone" };
        source = "worker-standalone";
      }
    } else {
      const mapping = await getChatGptProjectMapping(stateDir, projectId);
      if (mapping) {
        route = { mode: "project", projectRef: mapping.projectRef };
        source = "mapping";
      } else {
        route = { mode: "standalone" };
        source = "standalone";
      }
    }
  }
''',
)
replace_once(
    browser,
    '    route: await resolveDurableBrowserWorkerRoute(stateDir, input.workerId, projectId, current?.route),',
    '    route: await pinBrowserWorkerPlacement(stateDir, input.workerId, projectId, undefined, current?.route),',
)

manager = "src/agents/manager.ts"
replace_once(
    manager,
    '''} from "./execution-settings.js";
import {
  cancelWorker,''',
    '''} from "./execution-settings.js";
import { pinBrowserWorkerPlacement, type BrowserWorkerRoute } from "./browser-controller.js";
import {
  cancelWorker,''',
)
replace_once(
    manager,
    '''  baseRef?: string;
  execution?: WorkerExecutionPreference;
}''',
    '''  baseRef?: string;
  execution?: WorkerExecutionPreference;
  placement?: BrowserWorkerRoute;
}''',
)
replace_once(
    manager,
    '''  const worker = await createWorker(stateDir, {
    projectId: input.project.projectId,
    task: input.task,
    ...(hasExecutionIntent(executionIntent) ? { executionIntent } : {}),
  });

  try {''',
    '''  const worker = await createWorker(stateDir, {
    projectId: input.project.projectId,
    task: input.task,
    ...(hasExecutionIntent(executionIntent) ? { executionIntent } : {}),
  });
  await pinBrowserWorkerPlacement(
    stateDir,
    worker.workerId,
    worker.projectId,
    input.placement,
  );

  try {''',
)

agent_tools = "src/server/agent-tools.ts"
replace_once(
    agent_tools,
    '''        execution: z.object({
          model: z.string().max(200).optional(),
          reasoningEffort: z.enum(WORKER_REASONING_EFFORTS).optional(),
          fallbackPolicy: z.enum(WORKER_EXECUTION_FALLBACK_POLICIES).optional(),
        }).strict().optional(),
      },''',
    '''        execution: z.object({
          model: z.string().max(200).optional(),
          reasoningEffort: z.enum(WORKER_REASONING_EFFORTS).optional(),
          fallbackPolicy: z.enum(WORKER_EXECUTION_FALLBACK_POLICIES).optional(),
        }).strict().optional(),
        placement: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("standalone") }).strict(),
          z.object({
            mode: z.literal("project"),
            projectUrl: z.string().url().max(2048),
          }).strict(),
        ]).optional(),
      },''',
)
replace_once(
    agent_tools,
    '''          baseRef: input.baseRef,
          execution: input.execution,
        });''',
    '''          baseRef: input.baseRef,
          execution: input.execution,
          placement: input.placement?.mode === "project"
            ? { mode: "project", projectRef: { url: input.placement.projectUrl } }
            : input.placement?.mode === "standalone"
              ? { mode: "standalone" }
              : undefined,
        });''',
)
replace_once(
    agent_tools,
    '''        "Create a durable worker plus its isolated managed Git branch/worktree when the active lease permits worker orchestration. Optional execution settings override global/project worker defaults for this worker only and are durably resolved at spawn time. This does not grant the parent direct project-write authority. Browser worker launch is a later step, so do not claim the task is running until the worker becomes running.",''',
    '''        "Create a durable worker plus its isolated managed Git branch/worktree when the active lease permits worker orchestration. Optional execution settings override global/project worker defaults for this worker only. Optional placement can request standalone ChatGPT or one ChatGPT Project for this worker; an EXE-configured fixed Worker Project URL always takes precedence. Execution and placement are durably resolved at spawn time. This does not grant the parent direct project-write authority. Browser worker launch is a later step, so do not claim the task is running until the worker becomes running.",''',
)

placement_test = "src/agents/browser-placement-policy.test.ts"
replace_once(
    placement_test,
    '''  markBrowserWorkerLaunching,
  prepareBrowserWorkerSession,
  setChatGptProjectMapping,''',
    '''  markBrowserWorkerLaunching,
  pinBrowserWorkerPlacement,
  prepareBrowserWorkerSession,
  setChatGptProjectMapping,''',
)
replace_once(
    placement_test,
    '''    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "https://chatgpt.com/g/g-p-fixed/project#fragment";

    const first = await prepareBrowserWorkerSession(stateDir, {''',
    '''    process.env.CHATGPT2CODEX_WORKER_PROJECT_URL = "https://chatgpt.com/g/g-p-fixed/project#fragment";
    await pinBrowserWorkerPlacement(stateDir, worker.workerId, "project-1", {
      mode: "project",
      projectRef: { url: "https://chatgpt.com/g/g-p-worker-request/project" },
    });

    const first = await prepareBrowserWorkerSession(stateDir, {''',
)

new_test = Path("src/agents/manager-placement.test.ts")
if new_test.exists():
    raise RuntimeError(f"{new_test}: already exists")
new_test.write_text('''import { execFile } from "node:child_process";
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
  await writeFile(path.join(root, "README.md"), "baseline\\n", "utf8");
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
''', encoding="utf-8")

print("M7 per-worker placement follow-up applied")
