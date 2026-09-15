import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { loadSkillDirectory, loadSkillMetadata } from "./loader.js";
import type {
  LoadedSkill,
  SkillDiagnostic,
  SkillMetadata,
  SkillRegistrySnapshot,
  SkillScope,
} from "./types.js";

const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".github",
  ".svn",
  ".hg",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
]);

export const PROJECT_SKILLS_RELATIVE_DIR = path.join(".agents", "skills");
export const GLOBAL_SKILLS_RELATIVE_DIR = "skills";
export const MAX_SKILL_DISCOVERY_DEPTH = 4;
export const MAX_SKILL_DISCOVERY_DIRS = 256;

export function projectSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_SKILLS_RELATIVE_DIR);
}

export function globalSkillsDir(stateDir: string): string {
  return path.join(stateDir, GLOBAL_SKILLS_RELATIVE_DIR);
}

async function discoverRoot(params: {
  rootDir: string;
  scope: SkillScope;
}): Promise<{ skills: SkillMetadata[]; diagnostics: SkillDiagnostic[] }> {
  const skills: SkillMetadata[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  let rootRealPath: string;
  try {
    const rootInfo = await lstat(params.rootDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      diagnostics.push({
        kind: "unsafe",
        path: params.rootDir,
        message: "skill root must be a real directory, not a symlink",
      });
      return { skills, diagnostics };
    }
    rootRealPath = await realpath(params.rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { skills, diagnostics };
    diagnostics.push({
      kind: "read",
      path: params.rootDir,
      message: error instanceof Error ? error.message : String(error),
    });
    return { skills, diagnostics };
  }

  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited >= MAX_SKILL_DISCOVERY_DIRS) return;
    visited += 1;

    const direct = await loadSkillMetadata({ rootDir: rootRealPath, skillDir: dir, scope: params.scope });
    if (direct.metadata) {
      skills.push(direct.metadata);
      return;
    }
    if (direct.diagnostic && direct.diagnostic.kind !== "missing") {
      diagnostics.push(direct.diagnostic);
      return;
    }
    if (depth >= MAX_SKILL_DISCOVERY_DEPTH) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        kind: "read",
        path: dir,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (visited >= MAX_SKILL_DISCOVERY_DIRS) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  };

  let children;
  try {
    children = await readdir(rootRealPath, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      kind: "read",
      path: rootRealPath,
      message: error instanceof Error ? error.message : String(error),
    });
    return { skills, diagnostics };
  }

  for (const child of children.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (visited >= MAX_SKILL_DISCOVERY_DIRS) break;
    if (!child.isDirectory() || child.isSymbolicLink() || EXCLUDED_DIR_NAMES.has(child.name)) continue;
    await walk(path.join(rootRealPath, child.name), 1);
  }

  if (visited >= MAX_SKILL_DISCOVERY_DIRS) {
    diagnostics.push({
      kind: "limit",
      path: rootRealPath,
      message: `skill discovery stopped after ${MAX_SKILL_DISCOVERY_DIRS} directories`,
    });
  }
  return { skills, diagnostics };
}

export async function discoverSkillRegistry(params: {
  stateDir: string;
  projectRoot?: string;
}): Promise<SkillRegistrySnapshot> {
  const global = await discoverRoot({ rootDir: globalSkillsDir(params.stateDir), scope: "global" });
  const project = params.projectRoot
    ? await discoverRoot({ rootDir: projectSkillsDir(params.projectRoot), scope: "project" })
    : { skills: [] as SkillMetadata[], diagnostics: [] as SkillDiagnostic[] };

  const selected = new Map<string, SkillMetadata>();
  const diagnostics = [...global.diagnostics, ...project.diagnostics];

  for (const skill of global.skills) {
    const existing = selected.get(skill.name);
    if (existing) {
      diagnostics.push({
        kind: "collision",
        path: skill.filePath,
        message: `duplicate global skill '${skill.name}' ignored; first discovered path wins (${existing.filePath})`,
      });
      continue;
    }
    selected.set(skill.name, skill);
  }

  for (const skill of project.skills) {
    const existing = selected.get(skill.name);
    if (existing) {
      diagnostics.push({
        kind: "collision",
        path: skill.filePath,
        message: `project skill '${skill.name}' overrides ${existing.scope} skill at ${existing.filePath}`,
      });
    }
    selected.set(skill.name, skill);
  }

  return {
    skills: [...selected.values()].sort((a, b) => a.name.localeCompare(b.name, "en")),
    diagnostics,
  };
}

export async function loadRegisteredSkill(params: {
  stateDir: string;
  projectRoot?: string;
  name: string;
}): Promise<{ skill?: LoadedSkill; diagnostics: SkillDiagnostic[] }> {
  const snapshot = await discoverSkillRegistry(params);
  const metadata = snapshot.skills.find((skill) => skill.name === params.name);
  if (!metadata) return { diagnostics: snapshot.diagnostics };
  const rootDir = metadata.scope === "project"
    ? projectSkillsDir(params.projectRoot!)
    : globalSkillsDir(params.stateDir);
  const loaded = await loadSkillDirectory({ rootDir, skillDir: metadata.baseDir, scope: metadata.scope });
  return {
    skill: loaded.skill,
    diagnostics: loaded.diagnostic ? [...snapshot.diagnostics, loaded.diagnostic] : snapshot.diagnostics,
  };
}
