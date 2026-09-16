import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SETTINGS_VERSION = 1 as const;

/**
 * Normalized ChatGPT Web reasoning choices for M6. The browser adapter owns
 * UI label/selector translation; durable/runtime state uses these stable keys.
 */
export const WORKER_REASONING_EFFORTS = ["instant", "medium", "high", "extra-high"] as const;
export type WorkerReasoningEffort = (typeof WORKER_REASONING_EFFORTS)[number];

export const WORKER_EXECUTION_FALLBACK_POLICIES = ["fail-closed", "allow-current"] as const;
export type WorkerExecutionFallbackPolicy = (typeof WORKER_EXECUTION_FALLBACK_POLICIES)[number];

export type WorkerExecutionPreferenceSource = "worker" | "project" | "global";
export type WorkerExecutionFallbackSource = WorkerExecutionPreferenceSource | "default";
export type WorkerExecutionSettingsScope = "global" | "project";

export interface WorkerExecutionPreference {
  model?: string;
  reasoningEffort?: WorkerReasoningEffort;
  fallbackPolicy?: WorkerExecutionFallbackPolicy;
}

export interface WorkerExecutionIntent {
  requested?: WorkerExecutionPreference;
  resolved?: WorkerExecutionPreference;
  sources?: {
    model?: WorkerExecutionPreferenceSource;
    reasoningEffort?: WorkerExecutionPreferenceSource;
    fallbackPolicy?: WorkerExecutionFallbackSource;
  };
}

interface StoredWorkerExecutionScope {
  preference: WorkerExecutionPreference;
  updatedAt: number;
}

interface StoredProjectWorkerExecutionScope extends StoredWorkerExecutionScope {
  projectId: string;
}

interface WorkerExecutionSettingsFile {
  version: typeof SETTINGS_VERSION;
  updatedAt: number;
  global?: StoredWorkerExecutionScope;
  projects: StoredProjectWorkerExecutionScope[];
}

export interface WorkerExecutionSettingsSnapshot {
  global?: WorkerExecutionPreference;
  project?: WorkerExecutionPreference;
}

const WorkerExecutionPreferenceSchema = z.object({
  model: z.string().max(200).optional(),
  reasoningEffort: z.enum(WORKER_REASONING_EFFORTS).optional(),
  fallbackPolicy: z.enum(WORKER_EXECUTION_FALLBACK_POLICIES).optional(),
}).strict() satisfies z.ZodType<WorkerExecutionPreference>;

const StoredWorkerExecutionScopeSchema = z.object({
  preference: WorkerExecutionPreferenceSchema,
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<StoredWorkerExecutionScope>;

const StoredProjectWorkerExecutionScopeSchema = StoredWorkerExecutionScopeSchema.extend({
  projectId: z.string().min(1),
}) satisfies z.ZodType<StoredProjectWorkerExecutionScope>;

const WorkerExecutionSettingsFileSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  updatedAt: z.number().int().nonnegative(),
  global: StoredWorkerExecutionScopeSchema.optional(),
  projects: z.array(StoredProjectWorkerExecutionScopeSchema),
}) satisfies z.ZodType<WorkerExecutionSettingsFile>;

function agentsDir(stateDir: string): string {
  return path.join(stateDir, "agents");
}

function settingsPath(stateDir: string): string {
  return path.join(agentsDir(stateDir), "worker-execution-settings.json");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    // Non-fatal on filesystems without POSIX permission bits.
  }
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(target));
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  try {
    await fs.chmod(temp, FILE_MODE);
  } catch {
    // Non-fatal on filesystems without POSIX permission bits.
  }
  await fs.rename(temp, target);
}

function emptySettingsFile(): WorkerExecutionSettingsFile {
  return { version: SETTINGS_VERSION, updatedAt: 0, projects: [] };
}

function normalizeProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "Project id must not be empty");
  }
  return normalized;
}

export function normalizeWorkerExecutionPreference(
  preference: WorkerExecutionPreference,
): WorkerExecutionPreference {
  const parsed = WorkerExecutionPreferenceSchema.safeParse(preference);
  if (!parsed.success) {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      parsed.error.issues[0]?.message ?? "Invalid worker execution preference",
    );
  }

  const model = parsed.data.model?.trim();
  if (parsed.data.model !== undefined && !model) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Worker execution model must not be empty");
  }

  return {
    ...(model ? { model } : {}),
    ...(parsed.data.reasoningEffort ? { reasoningEffort: parsed.data.reasoningEffort } : {}),
    ...(parsed.data.fallbackPolicy ? { fallbackPolicy: parsed.data.fallbackPolicy } : {}),
  };
}

function hasPreferenceValue(preference: WorkerExecutionPreference | undefined): preference is WorkerExecutionPreference {
  return Boolean(
    preference &&
      (preference.model !== undefined ||
        preference.reasoningEffort !== undefined ||
        preference.fallbackPolicy !== undefined),
  );
}

function normalizeConfiguredPreference(preference: WorkerExecutionPreference): WorkerExecutionPreference {
  const normalized = normalizeWorkerExecutionPreference(preference);
  if (!hasPreferenceValue(normalized)) {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      "Worker execution settings must include model, reasoningEffort, or fallbackPolicy",
    );
  }
  return normalized;
}

function normalizeStoredFile(file: WorkerExecutionSettingsFile): WorkerExecutionSettingsFile {
  return {
    version: SETTINGS_VERSION,
    updatedAt: file.updatedAt,
    ...(file.global
      ? {
          global: {
            preference: normalizeConfiguredPreference(file.global.preference),
            updatedAt: file.global.updatedAt,
          },
        }
      : {}),
    projects: file.projects
      .map((entry) => ({
        projectId: normalizeProjectId(entry.projectId),
        preference: normalizeConfiguredPreference(entry.preference),
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => a.projectId.localeCompare(b.projectId)),
  };
}

async function readSettingsFile(stateDir: string): Promise<WorkerExecutionSettingsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(stateDir), "utf8"));
    const parsed = WorkerExecutionSettingsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Stored worker execution settings failed validation: ${parsed.error.issues[0]?.message ?? "invalid state"}`,
      );
    }
    return normalizeStoredFile(parsed.data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySettingsFile();
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `Could not read worker execution settings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeSettingsFile(stateDir: string, file: WorkerExecutionSettingsFile): Promise<void> {
  const validated = WorkerExecutionSettingsFileSchema.parse(normalizeStoredFile(file));
  await atomicWriteJson(settingsPath(stateDir), validated);
}

export async function getWorkerExecutionSettingsSnapshot(
  stateDir: string,
  projectId?: string,
): Promise<WorkerExecutionSettingsSnapshot> {
  const file = await readSettingsFile(stateDir);
  const normalizedProjectId = projectId === undefined ? undefined : normalizeProjectId(projectId);
  const project = normalizedProjectId
    ? file.projects.find((entry) => entry.projectId === normalizedProjectId)?.preference
    : undefined;
  return {
    ...(file.global ? { global: file.global.preference } : {}),
    ...(project ? { project } : {}),
  };
}

export async function setWorkerExecutionPreference(
  stateDir: string,
  scope: WorkerExecutionSettingsScope,
  preference: WorkerExecutionPreference,
  projectId?: string,
): Promise<WorkerExecutionPreference> {
  const normalized = normalizeConfiguredPreference(preference);
  const file = await readSettingsFile(stateDir);
  const now = Date.now();

  if (scope === "global") {
    await writeSettingsFile(stateDir, {
      ...file,
      updatedAt: now,
      global: { preference: normalized, updatedAt: now },
    });
    return normalized;
  }

  if (scope !== "project") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Unsupported worker execution settings scope: ${scope}`);
  }
  if (projectId === undefined) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Project scope requires an active project");
  }

  const normalizedProjectId = normalizeProjectId(projectId);
  const projects = file.projects.filter((entry) => entry.projectId !== normalizedProjectId);
  projects.push({ projectId: normalizedProjectId, preference: normalized, updatedAt: now });
  projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
  await writeSettingsFile(stateDir, { ...file, updatedAt: now, projects });
  return normalized;
}

export async function clearWorkerExecutionPreference(
  stateDir: string,
  scope: WorkerExecutionSettingsScope,
  projectId?: string,
): Promise<boolean> {
  const file = await readSettingsFile(stateDir);
  if (scope === "global") {
    if (!file.global) return false;
    const { global: _ignored, ...rest } = file;
    await writeSettingsFile(stateDir, { ...rest, updatedAt: Date.now() });
    return true;
  }

  if (scope !== "project") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Unsupported worker execution settings scope: ${scope}`);
  }
  if (projectId === undefined) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Project scope requires an active project");
  }

  const normalizedProjectId = normalizeProjectId(projectId);
  const projects = file.projects.filter((entry) => entry.projectId !== normalizedProjectId);
  if (projects.length === file.projects.length) return false;
  await writeSettingsFile(stateDir, { ...file, updatedAt: Date.now(), projects });
  return true;
}

function chooseField<T>(
  workerValue: T | undefined,
  projectValue: T | undefined,
  globalValue: T | undefined,
): { value?: T; source?: WorkerExecutionPreferenceSource } {
  if (workerValue !== undefined) return { value: workerValue, source: "worker" };
  if (projectValue !== undefined) return { value: projectValue, source: "project" };
  if (globalValue !== undefined) return { value: globalValue, source: "global" };
  return {};
}

export function resolveWorkerExecutionIntent(input: {
  worker?: WorkerExecutionPreference;
  project?: WorkerExecutionPreference;
  global?: WorkerExecutionPreference;
}): WorkerExecutionIntent {
  const worker = input.worker ? normalizeWorkerExecutionPreference(input.worker) : undefined;
  const project = input.project ? normalizeWorkerExecutionPreference(input.project) : undefined;
  const global = input.global ? normalizeWorkerExecutionPreference(input.global) : undefined;

  const model = chooseField(worker?.model, project?.model, global?.model);
  const reasoning = chooseField(
    worker?.reasoningEffort,
    project?.reasoningEffort,
    global?.reasoningEffort,
  );
  const fallback = chooseField(
    worker?.fallbackPolicy,
    project?.fallbackPolicy,
    global?.fallbackPolicy,
  );

  let fallbackPolicy = fallback.value;
  let fallbackSource: WorkerExecutionFallbackSource | undefined = fallback.source;
  if (!fallbackPolicy && (model.value !== undefined || reasoning.value !== undefined)) {
    fallbackPolicy = "fail-closed";
    fallbackSource = "default";
  }

  const requested = hasPreferenceValue(worker) ? worker : undefined;
  const resolved: WorkerExecutionPreference = {
    ...(model.value !== undefined ? { model: model.value } : {}),
    ...(reasoning.value !== undefined ? { reasoningEffort: reasoning.value } : {}),
    ...(fallbackPolicy !== undefined ? { fallbackPolicy } : {}),
  };
  const sources: NonNullable<WorkerExecutionIntent["sources"]> = {
    ...(model.source ? { model: model.source } : {}),
    ...(reasoning.source ? { reasoningEffort: reasoning.source } : {}),
    ...(fallbackSource ? { fallbackPolicy: fallbackSource } : {}),
  };

  return {
    ...(requested ? { requested } : {}),
    ...(hasPreferenceValue(resolved) ? { resolved } : {}),
    ...(Object.keys(sources).length > 0 ? { sources } : {}),
  };
}
