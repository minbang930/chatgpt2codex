import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SKILL_FILE_BYTES, loadSkillDirectory } from "./loader.js";
import {
  discoverSkillRegistry,
  globalSkillsDir,
  loadRegisteredSkill,
  projectSkillsDir,
} from "./registry.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(dir: string, name: string, description: string, body = "Instructions"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills/registry", () => {
  it("discovers global and project skills with project precedence", async () => {
    const stateDir = await temp("chatgpt2codex-skills-state-");
    const projectRoot = await temp("chatgpt2codex-skills-project-");
    await writeSkill(path.join(globalSkillsDir(stateDir), "shared"), "shared-skill", "global version");
    await writeSkill(path.join(globalSkillsDir(stateDir), "global-only"), "global-only", "global only");
    await writeSkill(path.join(projectSkillsDir(projectRoot), "shared"), "shared-skill", "project version");
    await writeSkill(path.join(projectSkillsDir(projectRoot), "project-only"), "project-only", "project only");

    const snapshot = await discoverSkillRegistry({ stateDir, projectRoot });
    expect(snapshot.skills.map((skill) => [skill.name, skill.scope, skill.description])).toEqual([
      ["global-only", "global", "global only"],
      ["project-only", "project", "project only"],
      ["shared-skill", "project", "project version"],
    ]);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.kind === "collision")).toBe(true);
  });

  it("supports bounded nested skill directories but stops descending once a SKILL.md owns a directory", async () => {
    const stateDir = await temp("chatgpt2codex-skills-nested-");
    const root = globalSkillsDir(stateDir);
    await writeSkill(path.join(root, "frontend", "taste"), "taste", "frontend guidance");
    await writeSkill(path.join(root, "frontend", "taste", "references", "fake"), "nested-fake", "must not load");

    const snapshot = await discoverSkillRegistry({ stateDir });
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["taste"]);
  });

  it("loads the full selected skill on demand instead of putting its body in registry metadata", async () => {
    const stateDir = await temp("chatgpt2codex-skills-load-");
    await writeSkill(path.join(globalSkillsDir(stateDir), "docs"), "docs-helper", "find docs", "# Full body\nUse references only when needed.");

    const snapshot = await discoverSkillRegistry({ stateDir });
    expect(snapshot.skills[0]).not.toHaveProperty("content");
    const loaded = await loadRegisteredSkill({ stateDir, name: "docs-helper" });
    expect(loaded.skill?.content).toContain("# Full body");
    expect(loaded.skill?.body).toContain("Use references only when needed.");
  });

  it("rejects directories outside the configured root and oversized SKILL.md files", async () => {
    const root = await temp("chatgpt2codex-skills-root-");
    const outside = await temp("chatgpt2codex-skills-outside-");
    await writeSkill(outside, "outside", "outside root");

    const escaped = await loadSkillDirectory({ rootDir: root, skillDir: outside, scope: "global" });
    expect(escaped.skill).toBeUndefined();
    expect(escaped.diagnostic?.kind).toBe("unsafe");

    const huge = path.join(root, "huge");
    await mkdir(huge, { recursive: true });
    await writeFile(
      path.join(huge, "SKILL.md"),
      `---\nname: huge\ndescription: too large\n---\n${"x".repeat(MAX_SKILL_FILE_BYTES + 1)}`,
      "utf8",
    );
    const oversized = await loadSkillDirectory({ rootDir: root, skillDir: huge, scope: "global" });
    expect(oversized.skill).toBeUndefined();
    expect(oversized.diagnostic?.kind).toBe("limit");
  });
});
