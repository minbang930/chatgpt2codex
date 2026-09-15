import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SKILL_RESOURCE_BYTES,
  loadSkillDirectory,
  readSkillResource,
} from "./loader.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadedSkill() {
  const root = await temp("chatgpt2codex-skill-resource-");
  const skillDir = path.join(root, "reviewer");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await mkdir(path.join(skillDir, "templates"), { recursive: true });
  await mkdir(path.join(skillDir, "assets"), { recursive: true });
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: reviewer\ndescription: Review helper\n---\n\nUse the supporting resources.\n",
    "utf8",
  );
  const loaded = await loadSkillDirectory({ rootDir: root, skillDir, scope: "global" });
  if (!loaded.skill) throw new Error(loaded.diagnostic?.message ?? "skill failed to load");
  return { root, skillDir, skill: loaded.skill };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills/resource reads", () => {
  it("reads bounded UTF-8 resources from the three non-executable resource roots", async () => {
    const { skillDir, skill } = await loadedSkill();
    await writeFile(path.join(skillDir, "references", "guide.md"), "Reference guide\n", "utf8");
    await writeFile(path.join(skillDir, "templates", "answer.txt"), "Template body\n", "utf8");
    await writeFile(path.join(skillDir, "assets", "notes.txt"), "Asset notes\n", "utf8");

    await expect(readSkillResource(skill, "references/guide.md")).resolves.toMatchObject({
      kind: "references",
      encoding: "utf8",
      content: "Reference guide\n",
    });
    await expect(readSkillResource(skill, "templates/answer.txt")).resolves.toMatchObject({ kind: "templates" });
    await expect(readSkillResource(skill, "assets/notes.txt")).resolves.toMatchObject({ kind: "assets" });
  });

  it("rejects traversal, absolute paths, and package script paths", async () => {
    const { skillDir, skill } = await loadedSkill();
    await writeFile(path.join(skillDir, "scripts", "helper.txt"), "not exposed\n", "utf8");

    await expect(readSkillResource(skill, "../SKILL.md")).rejects.toThrow(/unsafe path segment/i);
    await expect(readSkillResource(skill, path.resolve(skillDir, "SKILL.md"))).rejects.toThrow(/relative/i);
    await expect(readSkillResource(skill, "scripts/helper.txt")).rejects.toThrow(/only be read from/i);
  });

  it("returns binary resources as base64 and rejects oversized files", async () => {
    const { skillDir, skill } = await loadedSkill();
    await writeFile(path.join(skillDir, "assets", "binary.bin"), Buffer.from([0, 255, 1, 254]));
    await writeFile(path.join(skillDir, "assets", "large.bin"), Buffer.alloc(MAX_SKILL_RESOURCE_BYTES + 1));

    await expect(readSkillResource(skill, "assets/binary.bin")).resolves.toMatchObject({
      encoding: "base64",
      content: Buffer.from([0, 255, 1, 254]).toString("base64"),
    });
    await expect(readSkillResource(skill, "assets/large.bin")).rejects.toThrow(/read limit/i);
  });
});
