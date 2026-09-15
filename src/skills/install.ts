import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { loadSkillDirectory } from "./loader.js";
import { discoverSkillRoot, globalSkillsDir, projectSkillsDir } from "./registry.js";
import type { LoadedSkill, SkillMetadata, SkillScope } from "./types.js";

const execFileAsync = promisify(execFile);
const PROVENANCE_DIR = ".chatgpt2codex";
const PROVENANCE_FILE = "source.json";
const MAX_INSTALL_FILES = 2048;
const MAX_INSTALL_BYTES = 32 * 1024 * 1024;
const SKIP_COPY_NAMES = new Set([".git", ".svn", ".hg", PROVENANCE_DIR]);

export type SkillSourceKind = "local" | "git";

export interface SkillSourceProvenance {
  version: 1;
  sourceKind: SkillSourceKind;
  source: string;
  skillName: string;
  requestedRef?: string;
  resolvedCommit?: string;
  installedAt: string;
  updatedAt?: string;
}

export interface SkillInstallRequest {
  stateDir: string;
  workspaceRoot: string;
  projectRoot?: string;
  scope: SkillScope;
  source: string;
  skillName?: string;
  ref?: string;
}

export interface SkillInstallResult {
  skill: LoadedSkill;
  provenance: SkillSourceProvenance;
  targetDir: string;
}

function targetRoot(params: Pick<SkillInstallRequest, "stateDir" | "projectRoot" | "scope">): string {
  if (params.scope === "project") {
    if (!params.projectRoot) throw new Error("project-scoped skill install requires an active project");
    return projectSkillsDir(params.projectRoot);
  }
  return globalSkillsDir(params.stateDir);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function ensureManagedRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("skill install root must be a real directory, not a symlink");
  }
  return realpath(root);
}

function isGitSource(source: string): boolean {
  return /^https:\/\//i.test(source.trim()) || source.trim().startsWith("git+https://");
}

function normalizeGitUrl(source: string): string {
  const normalized = source.trim().replace(/^git\+/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Git skill source must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Git skill source must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Git skill source must not embed credentials");
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

async function acquireGitSource(source: string, ref?: string): Promise<{
  rootDir: string;
  source: string;
  resolvedCommit: string;
  cleanup: () => Promise<void>;
}> {
  const url = normalizeGitUrl(source);
  const temp = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-skill-git-"));
  const repoDir = path.join(temp, "repo");
  try {
    await runGit(temp, ["clone", "--depth", "1", "--no-tags", "--", url, repoDir]);
    if (ref) {
      await runGit(repoDir, ["fetch", "--depth", "1", "origin", ref]);
      await runGit(repoDir, ["checkout", "--detach", "FETCH_HEAD"]);
    }
    const resolvedCommit = await runGit(repoDir, ["rev-parse", "HEAD"]);
    return {
      rootDir: repoDir,
      source: url,
      resolvedCommit,
      cleanup: () => rm(temp, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireLocalSource(source: string, workspaceRoot: string): Promise<{
  rootDir: string;
  source: string;
  cleanup: () => Promise<void>;
}> {
  const workspaceReal = await realpath(workspaceRoot);
  const requested = path.isAbsolute(source) ? source : path.resolve(workspaceRoot, source);
  const sourceReal = await realpath(requested);
  if (!isInsideRoot(workspaceReal, sourceReal)) {
    throw new Error("local skill source must remain inside the configured workspace root");
  }
  const info = await lstat(sourceReal);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("local skill source must be a real directory, not a symlink");
  }
  return { rootDir: sourceReal, source: sourceReal, cleanup: async () => undefined };
}

async function selectSkill(rootDir: string, requestedName?: string): Promise<SkillMetadata> {
  const discovered = await discoverSkillRoot({ rootDir, scope: "global" });
  if (requestedName) {
    const selected = discovered.skills.find((skill) => skill.name === requestedName);
    if (!selected) {
      const available = discovered.skills.slice(0, 20).map((skill) => skill.name).join(", ");
      throw new Error(
        available
          ? `skill '${requestedName}' was not found in source; available: ${available}`
          : `skill '${requestedName}' was not found in source`,
      );
    }
    return selected;
  }
  if (discovered.skills.length === 1) return discovered.skills[0]!;
  if (discovered.skills.length === 0) {
    const detail = discovered.diagnostics[0]?.message;
    throw new Error(detail ? `no valid SKILL.md found in source: ${detail}` : "no valid SKILL.md found in source");
  }
  const available = discovered.skills.slice(0, 20).map((skill) => skill.name).join(", ");
  throw new Error(`source contains multiple skills; specify skillName. Available: ${available}`);
}

async function copySkillTree(sourceDir: string, destinationDir: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const sourceRoot = await realpath(sourceDir);

  const copyDir = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_COPY_NAMES.has(entry.name)) continue;
      const sourcePath = path.join(from, entry.name);
      const targetPath = path.join(to, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`skill package contains a symlink: ${sourcePath}`);
      const sourceRealPath = await realpath(sourcePath);
      if (!isInsideRoot(sourceRoot, sourceRealPath)) {
        throw new Error(`skill package entry escapes its source root: ${sourcePath}`);
      }
      if (info.isDirectory()) {
        await copyDir(sourcePath, targetPath);
        continue;
      }
      if (!info.isFile()) throw new Error(`skill package contains an unsupported filesystem entry: ${sourcePath}`);
      files += 1;
      bytes += info.size;
      if (files > MAX_INSTALL_FILES) throw new Error(`skill package exceeds ${MAX_INSTALL_FILES} files`);
      if (bytes > MAX_INSTALL_BYTES) throw new Error(`skill package exceeds ${MAX_INSTALL_BYTES} bytes`);
      await copyFile(sourcePath, targetPath);
    }
  };

  await copyDir(sourceRoot, destinationDir);
}

function provenancePath(skillDir: string): string {
  return path.join(skillDir, PROVENANCE_DIR, PROVENANCE_FILE);
}

async function writeProvenance(skillDir: string, provenance: SkillSourceProvenance): Promise<void> {
  const dir = path.join(skillDir, PROVENANCE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(provenancePath(skillDir), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}

export async function readSkillProvenance(skillDir: string): Promise<SkillSourceProvenance | null> {
  try {
    const parsed = JSON.parse(await readFile(provenancePath(skillDir), "utf8")) as Partial<SkillSourceProvenance>;
    if (
      parsed.version !== 1 ||
      (parsed.sourceKind !== "local" && parsed.sourceKind !== "git") ||
      typeof parsed.source !== "string" ||
      typeof parsed.skillName !== "string" ||
      typeof parsed.installedAt !== "string"
    ) return null;
    return parsed as SkillSourceProvenance;
  } catch {
    return null;
  }
}

async function replaceManagedDirectory(rootReal: string, skillName: string, preparedDir: string, replace: boolean): Promise<string> {
  const targetDir = path.join(rootReal, skillName);
  try {
    const existing = await lstat(targetDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("existing skill target is not a safe directory");
    if (!replace) throw new Error(`skill '${skillName}' is already installed in this scope`);
    if (!(await readSkillProvenance(targetDir))) {
      throw new Error(`refusing to replace unmanaged skill '${skillName}'`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    if (replace) throw new Error(`managed skill '${skillName}' is not installed in this scope`);
  }

  if (!replace) {
    await rename(preparedDir, targetDir);
    return targetDir;
  }

  const backupDir = path.join(rootReal, `.backup-${skillName}-${randomUUID()}`);
  await rename(targetDir, backupDir);
  try {
    await rename(preparedDir, targetDir);
    await rm(backupDir, { recursive: true, force: true });
    return targetDir;
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await rename(backupDir, targetDir).catch(() => undefined);
    throw error;
  }
}

async function installFromSource(params: SkillInstallRequest & { replace: boolean; installedAt?: string }): Promise<SkillInstallResult> {
  const rootReal = await ensureManagedRoot(targetRoot(params));
  const acquired = isGitSource(params.source)
    ? await acquireGitSource(params.source, params.ref)
    : await acquireLocalSource(params.source, params.workspaceRoot);

  try {
    const selected = await selectSkill(acquired.rootDir, params.skillName);
    const preparedDir = path.join(rootReal, `.install-${selected.name}-${randomUUID()}`);
    const now = new Date().toISOString();
    const provenance: SkillSourceProvenance = {
      version: 1,
      sourceKind: isGitSource(params.source) ? "git" : "local",
      source: acquired.source,
      skillName: selected.name,
      ...(params.ref ? { requestedRef: params.ref } : {}),
      ...(isGitSource(params.source) ? { resolvedCommit: (acquired as { resolvedCommit?: string }).resolvedCommit } : {}),
      installedAt: params.installedAt ?? now,
      ...(params.replace ? { updatedAt: now } : {}),
    };

    try {
      await copySkillTree(selected.baseDir, preparedDir);
      await writeProvenance(preparedDir, provenance);
      const validation = await loadSkillDirectory({ rootDir: rootReal, skillDir: preparedDir, scope: params.scope });
      if (!validation.skill) {
        throw new Error(validation.diagnostic?.message ?? "installed skill failed validation");
      }
      const targetDir = await replaceManagedDirectory(rootReal, selected.name, preparedDir, params.replace);
      const loaded = await loadSkillDirectory({ rootDir: rootReal, skillDir: targetDir, scope: params.scope });
      if (!loaded.skill) throw new Error(loaded.diagnostic?.message ?? "installed skill could not be loaded");
      return { skill: loaded.skill, provenance, targetDir };
    } catch (error) {
      await rm(preparedDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await acquired.cleanup();
  }
}

export async function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult> {
  return installFromSource({ ...params, replace: false });
}

export async function updateSkill(params: {
  stateDir: string;
  workspaceRoot: string;
  projectRoot?: string;
  scope: SkillScope;
  name: string;
}): Promise<SkillInstallResult> {
  const rootReal = await ensureManagedRoot(targetRoot(params));
  const currentDir = path.join(rootReal, params.name);
  const provenance = await readSkillProvenance(currentDir);
  if (!provenance) throw new Error(`skill '${params.name}' is not a managed install and cannot be updated`);
  if (provenance.skillName !== params.name) throw new Error("skill provenance name does not match its install directory");
  return installFromSource({
    stateDir: params.stateDir,
    workspaceRoot: params.workspaceRoot,
    projectRoot: params.projectRoot,
    scope: params.scope,
    source: provenance.source,
    skillName: provenance.skillName,
    ref: provenance.requestedRef,
    replace: true,
    installedAt: provenance.installedAt,
  });
}

export async function removeSkill(params: {
  stateDir: string;
  projectRoot?: string;
  scope: SkillScope;
  name: string;
}): Promise<{ removed: boolean; targetDir: string }> {
  const rootReal = await ensureManagedRoot(targetRoot(params));
  const targetDir = path.join(rootReal, params.name);
  const provenance = await readSkillProvenance(targetDir);
  if (!provenance) throw new Error(`skill '${params.name}' is not a managed install and will not be removed`);
  if (provenance.skillName !== params.name) throw new Error("skill provenance name does not match its install directory");
  await rm(targetDir, { recursive: true, force: false });
  return { removed: true, targetDir };
}
