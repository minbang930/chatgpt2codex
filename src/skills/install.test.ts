import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill, readSkillProvenance, removeSkill, updateSkill } from "./install.js";
import { globalSkillsDir } from "./registry.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(dir: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills/install", () => {
  it("installs, updates, and removes a managed local skill snapshot", async () => {
    const workspace = await temp("chatgpt2codex-skill-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-state-");
    const source = path.join(workspace, "sources", "reviewer");
    await writeSkill(source, "reviewer", "Review code changes", "Version one instructions.");
    await mkdir(path.join(source, "references"), { recursive: true });
    await writeFile(path.join(source, "references", "checklist.md"), "check one\n", "utf8");

    const installed = await installSkill({
      stateDir,
      workspaceRoot: workspace,
      scope: "global",
      source,
    });
    expect(installed.skill.name).toBe("reviewer");
    expect(installed.skill.content).toContain("Version one instructions.");
    expect(installed.provenance).toMatchObject({ sourceKind: "local", skillName: "reviewer" });
    expect(await readFile(path.join(installed.targetDir, "references", "checklist.md"), "utf8")).toContain("check one");
    expect(await readSkillProvenance(installed.targetDir)).toMatchObject({ sourceKind: "local", skillName: "reviewer" });

    await writeSkill(source, "reviewer", "Review code changes", "Version two instructions.");
    const updated = await updateSkill({
      stateDir,
      workspaceRoot: workspace,
      scope: "global",
      name: "reviewer",
    });
    expect(updated.skill.content).toContain("Version two instructions.");
    expect(updated.provenance.installedAt).toBe(installed.provenance.installedAt);
    expect(updated.provenance.updatedAt).toBeTruthy();

    await removeSkill({ stateDir, scope: "global", name: "reviewer" });
    await expect(readFile(path.join(globalSkillsDir(stateDir), "reviewer", "SKILL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires skillName when a source contains multiple skills", async () => {
    const workspace = await temp("chatgpt2codex-skill-multi-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-multi-state-");
    const source = path.join(workspace, "collection");
    await writeSkill(path.join(source, "skills", "alpha"), "alpha", "Alpha skill", "alpha");
    await writeSkill(path.join(source, "skills", "beta"), "beta", "Beta skill", "beta");

    await expect(installSkill({
      stateDir,
      workspaceRoot: workspace,
      scope: "global",
      source,
    })).rejects.toThrow(/multiple skills.*skillName/i);

    const installed = await installSkill({
      stateDir,
      workspaceRoot: workspace,
      scope: "global",
      source,
      skillName: "beta",
    });
    expect(installed.skill.name).toBe("beta");
  });

  it("refuses local sources outside the configured workspace", async () => {
    const workspace = await temp("chatgpt2codex-skill-safe-workspace-");
    const outside = await temp("chatgpt2codex-skill-outside-");
    const stateDir = await temp("chatgpt2codex-skill-safe-state-");
    await writeSkill(outside, "outside", "Outside skill", "do not import");

    await expect(installSkill({
      stateDir,
      workspaceRoot: workspace,
      scope: "global",
      source: outside,
    })).rejects.toThrow(/inside the configured workspace root/i);
  });

  it("never overwrites or removes an unmanaged skill directory", async () => {
    const workspace = await temp("chatgpt2codex-skill-unmanaged-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-unmanaged-state-");
    const source = path.join(workspace, "source");
    await writeSkill(source, "manual", "Managed candidate", "candidate");
    const target = path.join(globalSkillsDir(stateDir), "manual");
    await writeSkill(target, "manual", "Manual install", "keep me");

    await expect(installSkill({
      stateDir,
      workspaceRoot: workspace,
      scope: "global",
      source,
    })).rejects.toThrow(/already installed/i);
    await expect(updateSkill({
      stateDir,
      workspaceRoot: workspace,
      scope: "global",
      name: "manual",
    })).rejects.toThrow(/not a managed install/i);
    await expect(removeSkill({ stateDir, scope: "global", name: "manual" })).rejects.toThrow(/not a managed install/i);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("keep me");
  });
});
