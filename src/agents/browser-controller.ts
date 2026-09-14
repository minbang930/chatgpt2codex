import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import { getWorker } from "./store.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const WORKER_ID_RE = /^wrk_[0-9a-fA-F-]{36}$/;

export interface ChatGptProjectRef {
  url: string;
  label?: string;
}

export type BrowserWorkerRoute =
  | { mode: "standalone" }
  | { mode: "project"; projectRef: ChatGptProjectRef };

export type BrowserWorkerSessionStatus =
  | "prepared"
  | "launching"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface BrowserWorkerSession {
  version: 1;
  workerId: string;
  projectId: string;
  route: BrowserWorkerRoute;
  status: BrowserWorkerSessionStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  launchedAt?: number;
  stoppedAt?: number;
  browserHandle?: string;
  lastError?: string;
}

interface ProjectRouteEntry {
  projectId: string;
  projectRef: ChatGptProjectRef;
  updatedAt: number;
}

interface ProjectRoutesFile {
  version: 1;
  updatedAt: number;
  mappings: ProjectRouteEntry[];
}

export interface BrowserWorkerLaunchInput {
  workerId: string;
  projectId: string;
  task: string;
  workerToken: string;
  route: BrowserWorkerRoute;
}

export interface BrowserWorkerLaunchResult {
  browserHandle: string;
}

export interface BrowserWorkerCancelInput {
  workerId: string;
  browserHandle?: string;
}

/**
 * Platform/browser-specific automation lives behind this interface. M2.2 only
 * defines the local orchestration boundary; a real ChatGPT Web implementation
 * is added in the launch/bootstrap slice.
 */
export interface BrowserWorkerDriver {
  launch(input: BrowserWorkerLaunchInput): Promise<BrowserWorkerLaunchResult>;
  cancel(input: BrowserWorkerCancelInput): Promise<void>;
}

const ChatGptProjectRefSchema = z.object({
  url: z.string().url(),
  label: z.string().min(1).max(200).optional(),
}).superRefine((value, ctx) => {
  try {
    const url = new URL(value.url);
    if (url.protocol !== "https:" || (url.hostname !== "chatgpt.com" && url.hostname !== "www.chatgpt.com")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ChatGPT Project URL must use https://chatgpt.com" });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid ChatGPT Project URL" });
  }
});

const BrowserWorkerRouteSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("standalone") }),
  z.object({ mode: z.literal("project"), projectRef: ChatGptProjectRefSchema }),
]) satisfies z.ZodType<BrowserWorkerRoute>;

const BrowserWorkerSessionSchema = z.object({
  version: z.literal(1),
  workerId: z.string().regex(WORKER_ID_RE),
  projectId: z.string().min(1),
  route: BrowserWorkerRouteSchema,
  status: z.enum(["prepared", "launching", "running", "stopping", "stopped", "failed"]),
  attempt: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  launchedAt: z.number().int().nonnegative().optional(),
  stoppedAt: z.number().int().nonnegative().optional(),
  browserHandle: z.string().min(1).max(512).optional(),
  lastError: z.string().min(1).max(4000).optional(),
}) satisfies z.ZodType<BrowserWorkerSession>;

const ProjectRouteEntrySchema = z.object({
  projectId: z.string().min(1),
  projectRef: ChatGptProjectRefSchema,
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<ProjectRouteEntry>;

const ProjectRoutesFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  mappings: z.array(ProjectRouteEntrySchema),
}) satisfies z.ZodType<ProjectRoutesFile>;

function agentsDir(stateDir: string): string {
  return path.join(stateDir, "agents");
}

function browserSessionsDir(stateDir: string): string {
  return path.join(agentsDir(stateDir), "browser-sessions");
}

function projectRoutesPath(stateDir: string): string {
  return path.join(agentsDir(stateDir), "chatgpt-project-routes.json");
}

function sessionPath(stateDir: string, workerId: string): string {
  if (!WORKER_ID_RE.test(workerId) || path.basename(workerId) !== workerId) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Invalid browser worker id: ${workerId}`);
  }
  return path.join(browserSessionsDir(stateDir), `${workerId}.json`);
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
    // Non-fatal.
  }
  await fs.rename(temp, target);
}

function normalizeProjectId(projectId: string): string {
  const value = projectId.trim();
  if (!value) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "Project id must not be empty");
  }
  return value;
}

function normalizeProjectRef(projectRef: ChatGptProjectRef): ChatGptProjectRef {
  const parsed = ChatGptProjectRefSchema.safeParse({
    url: projectRef.url.trim(),
    label: projectRef.label?.trim() || undefined,
  });
  if (!parsed.success) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, parsed.error.issues[0]?.message ?? "Invalid ChatGPT Project reference");
  }
  const url = new URL(parsed.data.url);
  url.hash = "";
  return { url: url.toString(), label: parsed.data.label };
}

async function readProjectRoutes(stateDir: string): Promise<ProjectRoutesFile> {
  try {
    const raw = JSON.parse(await fs.readFile(projectRoutesPath(stateDir), "utf8"));
    const parsed = ProjectRoutesFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Stored ChatGPT Project routing state failed validation");
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, updatedAt: Date.now(), mappings: [] };
    }
    throw error;
  }
}

async function writeProjectRoutes(stateDir: string, file: ProjectRoutesFile): Promise<void> {
  await atomicWriteJson(projectRoutesPath(stateDir), ProjectRoutesFileSchema.parse(file));
}

export async function setChatGptProjectMapping(
  stateDir: string,
  projectId: string,
  projectRef: ChatGptProjectRef,
): Promise<ProjectRouteEntry> {
  const normalizedProjectId = normalizeProjectId(projectId);
  const normalizedRef = normalizeProjectRef(projectRef);
  const file = await readProjectRoutes(stateDir);
  const now = Date.now();
  const entry: ProjectRouteEntry = {
    projectId: normalizedProjectId,
    projectRef: normalizedRef,
    updatedAt: now,
  };
  const mappings = file.mappings.filter((item) => item.projectId !== normalizedProjectId);
  mappings.push(entry);
  mappings.sort((a, b) => a.projectId.localeCompare(b.projectId));
  await writeProjectRoutes(stateDir, { version: 1, updatedAt: now, mappings });
  return entry;
}

export async function getChatGptProjectMapping(
  stateDir: string,
  projectId: string,
): Promise<ProjectRouteEntry | null> {
  const normalizedProjectId = normalizeProjectId(projectId);
  const file = await readProjectRoutes(stateDir);
  return file.mappings.find((item) => item.projectId === normalizedProjectId) ?? null;
}

export async function clearChatGptProjectMapping(stateDir: string, projectId: string): Promise<boolean> {
  const normalizedProjectId = normalizeProjectId(projectId);
  const file = await readProjectRoutes(stateDir);
  const mappings = file.mappings.filter((item) => item.projectId !== normalizedProjectId);
  if (mappings.length === file.mappings.length) return false;
  await writeProjectRoutes(stateDir, { version: 1, updatedAt: Date.now(), mappings });
  return true;
}

export async function resolveBrowserWorkerRoute(stateDir: string, projectId: string): Promise<BrowserWorkerRoute> {
  const mapping = await getChatGptProjectMapping(stateDir, projectId);
  return mapping ? { mode: "project", projectRef: mapping.projectRef } : { mode: "standalone" };
}

async function writeBrowserWorkerSession(stateDir: string, session: BrowserWorkerSession): Promise<void> {
  const validated = BrowserWorkerSessionSchema.parse(session);
  await atomicWriteJson(sessionPath(stateDir, session.workerId), validated);
}

export async function getBrowserWorkerSession(
  stateDir: string,
  workerId: string,
): Promise<BrowserWorkerSession | null> {
  let file: string;
  try {
    file = sessionPath(stateDir, workerId);
  } catch {
    return null;
  }
  try {
    const parsed = BrowserWorkerSessionSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isFinalBrowserStatus(status: BrowserWorkerSessionStatus): boolean {
  return status === "stopped" || status === "failed";
}

async function requireBrowserWorkerSession(stateDir: string, workerId: string): Promise<BrowserWorkerSession> {
  const session = await getBrowserWorkerSession(stateDir, workerId);
  if (!session) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Browser worker session not found: ${workerId}`);
  }
  return session;
}

export async function prepareBrowserWorkerSession(
  stateDir: string,
  input: { workerId: string; projectId: string },
): Promise<BrowserWorkerSession> {
  const projectId = normalizeProjectId(input.projectId);
  const worker = await getWorker(stateDir, input.workerId);
  if (!worker) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Worker not found: ${input.workerId}`);
  }
  if (worker.projectId !== projectId) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Browser worker ${input.workerId} is bound to project ${worker.projectId}`);
  }

  const current = await getBrowserWorkerSession(stateDir, input.workerId);
  if (current && !isFinalBrowserStatus(current.status)) {
    if (current.projectId !== projectId) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, `Browser worker ${input.workerId} is already bound to another project`);
    }
    return current;
  }

  const now = Date.now();
  const session: BrowserWorkerSession = {
    version: 1,
    workerId: input.workerId,
    projectId,
    route: await resolveBrowserWorkerRoute(stateDir, projectId),
    status: "prepared",
    attempt: (current?.attempt ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  await writeBrowserWorkerSession(stateDir, session);
  return session;
}

async function transitionBrowserWorkerSession(
  stateDir: string,
  workerId: string,
  allowedFrom: BrowserWorkerSessionStatus[],
  patch: Partial<BrowserWorkerSession>,
): Promise<BrowserWorkerSession> {
  const current = await requireBrowserWorkerSession(stateDir, workerId);
  if (!allowedFrom.includes(current.status)) {
    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `Browser worker ${workerId} cannot transition from ${current.status}`,
    );
  }
  const next: BrowserWorkerSession = {
    ...current,
    ...patch,
    version: 1,
    workerId: current.workerId,
    projectId: current.projectId,
    route: current.route,
    attempt: current.attempt,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
  };
  await writeBrowserWorkerSession(stateDir, next);
  return next;
}

export async function markBrowserWorkerLaunching(stateDir: string, workerId: string): Promise<BrowserWorkerSession> {
  return transitionBrowserWorkerSession(stateDir, workerId, ["prepared"], {
    status: "launching",
    lastError: undefined,
  });
}

export async function markBrowserWorkerRunning(
  stateDir: string,
  workerId: string,
  browserHandle: string,
): Promise<BrowserWorkerSession> {
  const handle = browserHandle.trim();
  if (!handle) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Browser worker handle must not be empty");
  }
  return transitionBrowserWorkerSession(stateDir, workerId, ["launching"], {
    status: "running",
    browserHandle: handle,
    launchedAt: Date.now(),
    lastError: undefined,
  });
}

export async function markBrowserWorkerStopping(stateDir: string, workerId: string): Promise<BrowserWorkerSession> {
  return transitionBrowserWorkerSession(stateDir, workerId, ["prepared", "launching", "running"], {
    status: "stopping",
  });
}

export async function markBrowserWorkerStopped(stateDir: string, workerId: string): Promise<BrowserWorkerSession> {
  return transitionBrowserWorkerSession(stateDir, workerId, ["stopping"], {
    status: "stopped",
    stoppedAt: Date.now(),
  });
}

export async function markBrowserWorkerFailed(
  stateDir: string,
  workerId: string,
  error: string,
): Promise<BrowserWorkerSession> {
  const message = error.trim() || "browser worker failed";
  return transitionBrowserWorkerSession(
    stateDir,
    workerId,
    ["prepared", "launching", "running", "stopping"],
    {
      status: "failed",
      stoppedAt: Date.now(),
      lastError: message,
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Small orchestration wrapper around a platform-specific driver. Browser state
 * is deliberately separate from durable coding-worker state. Launch/cancel
 * failures are recorded here and rethrown, but this controller never mutates
 * the worker's Git workspace, worker result inbox, or global Core session.
 */
export class BrowserWorkerController {
  constructor(
    private readonly stateDir: string,
    private readonly driver: BrowserWorkerDriver,
  ) {}

  prepare(workerId: string, projectId: string): Promise<BrowserWorkerSession> {
    return prepareBrowserWorkerSession(this.stateDir, { workerId, projectId });
  }

  async launch(input: Omit<BrowserWorkerLaunchInput, "route">): Promise<BrowserWorkerSession> {
    const prepared = await prepareBrowserWorkerSession(this.stateDir, {
      workerId: input.workerId,
      projectId: input.projectId,
    });
    await markBrowserWorkerLaunching(this.stateDir, input.workerId);
    try {
      const launched = await this.driver.launch({ ...input, route: prepared.route });
      return await markBrowserWorkerRunning(this.stateDir, input.workerId, launched.browserHandle);
    } catch (error) {
      await markBrowserWorkerFailed(this.stateDir, input.workerId, errorMessage(error)).catch(() => undefined);
      throw error;
    }
  }

  async cancel(workerId: string): Promise<BrowserWorkerSession> {
    const current = await requireBrowserWorkerSession(this.stateDir, workerId);
    if (isFinalBrowserStatus(current.status)) return current;
    const stopping = await markBrowserWorkerStopping(this.stateDir, workerId);
    try {
      await this.driver.cancel({ workerId, browserHandle: stopping.browserHandle });
      return await markBrowserWorkerStopped(this.stateDir, workerId);
    } catch (error) {
      await markBrowserWorkerFailed(this.stateDir, workerId, errorMessage(error)).catch(() => undefined);
      throw error;
    }
  }
}
