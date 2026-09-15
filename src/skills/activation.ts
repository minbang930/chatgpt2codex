import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { Store } from "../state/store.js";
import { findProject } from "../workspace/registry.js";
import { loadRegisteredSkill } from "./registry.js";
import type { LoadedSkill } from "./types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ACTIVATION_FILE = "skill-activations.json";
const skillNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const MAX_ACTIVE_SKILLS = 3;
export const MAX_ACTIVE_SKILL_CHARS = 8_000;
export const MAX_ACTIVE_SKILL_CONTEXT_CHARS = 24_000;
export const MAX_SKILL_CATALOG_ITEMS = 32;
export const MAX_SKILL_CATALOG_CHARS = 6_000;
export const MAX_SKILL_CATALOG_DESCRIPTION_CHARS = 500;

export type SkillActivationScope = "global" | "project";

export interface SkillActivationState {
  version: 1;
  updatedAt: number;
  global: string[];
  projects: Record<string, string[]>;
}

export interface ActivatedSkillSelection {
  names: string[];
  overflow: string[];
  global: string[];
  project: string[];
}

export interface ActivatedSkillContext {
  text: string;
  skills: Array<Pick<LoadedSkill, "name" | "description" | "scope"> & { chars: number }>;
  skipped: Array<{ name: string; reason: string }>;
  selectedNames: string[];
}

const ActivationStateSchema = z.object({
  version: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  global: z.array(skillNameSchema),
  projects: z.record(z.string(), z.array(skillNameSchema)),
}) satisfies z.ZodType<SkillActivationState>;

function emptyState(): SkillActivationState {
  return { version: 1, updatedAt: Date.now(), global: [], projects: {} };
}

function activationPath(stateDir: string): string {
  return path.join(stateDir, ACTIVATION_FILE);
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

async function writeState(stateDir: string, state: SkillActivationState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  const validated = ActivationStateSchema.parse({ ...state, updatedAt: Date.now() });
  const target = activationPath(stateDir);
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await rename(temp, target);
}

export async function readSkillActivationState(stateDir: string): Promise<SkillActivationState> {
  try {
    const parsed = ActivationStateSchema.safeParse(JSON.parse(await readFile(activationPath(stateDir), "utf8")));
    if (!parsed.success) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Stored Agent Skill activation state failed validation: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

function effectiveNames(state: SkillActivationState, projectId?: string): string[] {
  const global = state.global;
  const project = projectId ? (state.projects[projectId] ?? []) : [];
  return uniqueNames([...global, ...project]);
}

export async function getActivatedSkillSelection(
  stateDir: string,
  projectId?: string,
): Promise<ActivatedSkillSelection> {
  const state = await readSkillActivationState(stateDir);
  const global = [...state.global];
  const project = projectId ? [...(state.projects[projectId] ?? [])] : [];
  const combined = uniqueNames([...global, ...project]);
  return {
    names: combined.slice(0, MAX_ACTIVE_SKILLS),
    overflow: combined.slice(MAX_ACTIVE_SKILLS),
    global,
    project,
  };
}

export async function activateSkillName(params: {
  stateDir: string;
  name: string;
  activationScope: SkillActivationScope;
  projectId?: string;
}): Promise<ActivatedSkillSelection> {
  const name = skillNameSchema.parse(params.name);
  const state = await readSkillActivationState(params.stateDir);
  if (params.activationScope === "project") {
    if (!params.projectId) {
      throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Project-scoped Agent Skill activation requires an active project");
    }
    const current = state.projects[params.projectId] ?? [];
    state.projects[params.projectId] = uniqueNames([...current, name]);
  } else {
    state.global = uniqueNames([...state.global, name]);
  }

  const effective = effectiveNames(state, params.projectId);
  if (effective.length > MAX_ACTIVE_SKILLS) {
    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      `At most ${MAX_ACTIVE_SKILLS} Agent Skills may be active for one project context`,
    );
  }
  await writeState(params.stateDir, state);
  return getActivatedSkillSelection(params.stateDir, params.projectId);
}

export async function deactivateSkillName(params: {
  stateDir: string;
  name: string;
  activationScope: SkillActivationScope;
  projectId?: string;
}): Promise<ActivatedSkillSelection> {
  const name = skillNameSchema.parse(params.name);
  const state = await readSkillActivationState(params.stateDir);
  if (params.activationScope === "project") {
    if (!params.projectId) {
      throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Project-scoped Agent Skill activation requires an active project");
    }
    const next = (state.projects[params.projectId] ?? []).filter((item) => item !== name);
    if (next.length > 0) state.projects[params.projectId] = next;
    else delete state.projects[params.projectId];
  } else {
    state.global = state.global.filter((item) => item !== name);
  }
  await writeState(params.stateDir, state);
  return getActivatedSkillSelection(params.stateDir, params.projectId);
}

export function assertSkillCanActivate(skill: LoadedSkill): void {
  if (skill.content.length > MAX_ACTIVE_SKILL_CHARS) {
    throw new DomainError(
      ErrorCode.COMMAND_NOT_ALLOWED,
      `Skill '${skill.name}' is ${skill.content.length} characters; activation is limited to ${MAX_ACTIVE_SKILL_CHARS}. Use skill_view for larger skills.`,
    );
  }
}

export async function resolveProjectRootForSkillActivation(
  stateDir: string,
  projectId: string,
): Promise<string | undefined> {
  try {
    const entries = await new Store(stateDir).loadProjects();
    const result = findProject(entries, { projectId });
    return result.ok ? result.entry.root : undefined;
  } catch {
    return undefined;
  }
}

export async function loadActivatedSkillContext(params: {
  stateDir: string;
  projectId?: string;
  projectRoot?: string;
}): Promise<ActivatedSkillContext> {
  const selection = await getActivatedSkillSelection(params.stateDir, params.projectId);
  const projectRoot = params.projectRoot
    ?? (params.projectId ? await resolveProjectRootForSkillActivation(params.stateDir, params.projectId) : undefined);
  const skills: ActivatedSkillContext["skills"] = [];
  const skipped: ActivatedSkillContext["skipped"] = selection.overflow.map((name) => ({
    name,
    reason: `active-skill count budget exceeded (${MAX_ACTIVE_SKILLS})`,
  }));
  const blocks: string[] = [];
  let usedChars = 0;

  for (const name of selection.names) {
    const loaded = await loadRegisteredSkill({ stateDir: params.stateDir, projectRoot, name });
    if (!loaded.skill) {
      skipped.push({ name, reason: "skill is no longer installed in the effective registry" });
      continue;
    }
    if (loaded.skill.content.length > MAX_ACTIVE_SKILL_CHARS) {
      skipped.push({ name, reason: `skill exceeds the ${MAX_ACTIVE_SKILL_CHARS}-character activation budget` });
      continue;
    }
    if (usedChars + loaded.skill.content.length > MAX_ACTIVE_SKILL_CONTEXT_CHARS) {
      skipped.push({ name, reason: `combined activation context exceeds ${MAX_ACTIVE_SKILL_CONTEXT_CHARS} characters` });
      continue;
    }
    usedChars += loaded.skill.content.length;
    skills.push({
      name: loaded.skill.name,
      description: loaded.skill.description,
      scope: loaded.skill.scope,
      chars: loaded.skill.content.length,
    });
    blocks.push([
      `### Agent Skill: ${loaded.skill.name}`,
      `Installed scope: ${loaded.skill.scope}`,
      "",
      loaded.skill.content.trim(),
    ].join("\n"));
  }

  const text = blocks.length === 0
    ? ""
    : [
      "The following Agent Skills were explicitly activated by the parent agent.",
      "Treat them as additional task instructions only. They do not grant extra tools, permissions, or capabilities.",
      "",
      ...blocks,
    ].join("\n\n");

  return { text, skills, skipped, selectedNames: selection.names };
}
