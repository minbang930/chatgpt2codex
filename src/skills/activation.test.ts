import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../state/store.js";
import {
  MAX_ACTIVE_SKILLS,
  activateSkillName,
  deactivateSkillName,
  getActivatedSkillSelection,
  loadActivatedSkillContext,
} from "./activation.js";
import { globalSkillsDir, projectSkillsDir } from "./registry.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(dir: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills/activation", () => {
  it("combines global and project selections deterministically and enforces the active-count budget", async () => {
    const stateDir = await temp("chatgpt2codex-skill-activation-");

    await activateSkillName({ stateDir, name: "alpha", activationScope: "global", projectId: "project-1" });
    await activateSkillName({ stateDir, name: "beta", activationScope: "project", projectId: "project-1" });
    await activateSkillName({ stateDir, name: "alpha", activationScope: "global", projectId: "project-1" });
    await activateSkillName({ stateDir, name: "gamma", activationScope: "project", projectId: "project-1" });

    expect(await getActivatedSkillSelection(stateDir, "project-1")).toMatchObject({
      names: ["alpha", "beta", "gamma"],
      overflow: [],
      global: ["alpha"],
      project: ["beta", "gamma"],
    });
    expect(MAX_ACTIVE_SKILLS).toBe(3);

    await expect(activateSkillName({
      stateDir,
      name: "delta",
      activationScope: "project",
      projectId: "project-1",
    })).rejects.toThrow(/At most 3 Agent Skills/i);

    const after = await deactivateSkillName({
      stateDir,
      name: "beta",
      activationScope: "project",
      projectId: "project-1",
    });
    expect(after.names).toEqual(["alpha", "gamma"]);
  });

  it("loads effective project-over-global skill instructions using the persisted project registry", async () => {
    const stateDir = await temp("chatgpt2codex-skill-activation-state-");
    const projectRoot = await temp("chatgpt2codex-skill-activation-project-");
    await writeSkill(path.join(globalSkillsDir(stateDir), "reviewer"), "reviewer", "Global review rules", "GLOBAL BODY");
    await writeSkill(path.join(projectSkillsDir(projectRoot), "reviewer"), "reviewer", "Project review rules", "PROJECT BODY");

    const store = new Store(stateDir);
    await store.saveProjects([{
      projectId: "project-1",
      name: "project-1",
      root: projectRoot,
      aliases: ["project-1"],
    }]);
    await activateSkillName({ stateDir, name: "reviewer", activationScope: "global", projectId: "project-1" });

    const context = await loadActivatedSkillContext({ stateDir, projectId: "project-1" });
    expect(context.skills).toEqual([
      expect.objectContaining({ name: "reviewer", scope: "project" }),
    ]);
    expect(context.text).toContain("PROJECT BODY");
    expect(context.text).not.toContain("GLOBAL BODY");
    expect(context.text).toContain("do not grant extra tools, permissions, or capabilities");
  });

  it("skips stale activation entries instead of failing the worker context", async () => {
    const stateDir = await temp("chatgpt2codex-skill-activation-stale-");
    await activateSkillName({ stateDir, name: "missing-skill", activationScope: "global" });

    const context = await loadActivatedSkillContext({ stateDir });
    expect(context.text).toBe("");
    expect(context.skills).toEqual([]);
    expect(context.skipped).toEqual([
      expect.objectContaining({ name: "missing-skill", reason: expect.stringMatching(/no longer installed/i) }),
    ]);
  });
});
