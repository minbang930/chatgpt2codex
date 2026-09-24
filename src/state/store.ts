import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode, type ProjectRegistryEntry } from "../types.js";

/**
 * Central state store under `~/.local/share/chatgpt2codex/` (PRD §10):
 * projects.json (registry) and sessions.json (active project/mode/lease).
 *
 * Persistence rules (PRD §10, §11 SR-04/SR-08 adjacent hardening):
 *  - Directory created with mode 0700, files written with mode 0600.
 *  - Every write is atomic: write to a temp file in the same directory, then
 *    `rename()` over the target (rename is atomic on the same filesystem).
 *  - Every on-disk document is validated with zod before being handed back to
 *    callers; corrupt/foreign JSON never silently propagates.
 *  - Timestamps are integer epoch-ms.
 */

const ProjectRegistryEntrySchema = z.object({
  projectId: z.string(),
  name: z.string(),
  root: z.string(),
  aliases: z.array(z.string()),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
  hasAgentsMd: z.boolean().optional(),
  hasCodeBrain: z.boolean().optional(),
  packageHints: z.array(z.string()).optional(),
  lastSeenAt: z.string().optional(),
}) satisfies z.ZodType<ProjectRegistryEntry>;

const ProjectsFileSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  projects: z.array(ProjectRegistryEntrySchema),
});

type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

const LeaseSchema = z.object({
  projectId: z.string(),
  leaseId: z.string(),
  projectRoot: z.string(),
  preset: z.enum(["read-only", "tests-only", "full-write", "image-only", "control"]),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

const ControlLeaseSchema = LeaseSchema.extend({ preset: z.literal("control") });

/**
 * Session document shape (active project, mode, lease) — PRD §6, §7.
 *
 * `controlLease` is the durable explicit local-control authorization lane.
 * `adminControlLease` is separate authority minted automatically only while
 * the locally configured Full Computer Use (Admin) mode is active. Keeping the
 * lanes separate means turning Admin mode off immediately makes its lease
 * unusable without weakening an explicitly armed restricted-mode control lease.
 */
const SessionSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  activeProjectId: z.string().nullable(),
  mode: z.enum(["observe", "read", "edit", "verify", "danger"]),
  lease: LeaseSchema.nullable(),
  controlLease: ControlLeaseSchema.nullable().default(null),
  adminControlLease: ControlLeaseSchema.nullable().default(null),
});

export type SessionDocument = z.infer<typeof SessionSchema>;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const PROJECTS_FILE = "projects.json";
const SESSIONS_FILE = "sessions.json";

function emptyProjectsFile(): ProjectsFile {
  return { version: 1, updatedAt: Date.now(), projects: [] };
}

function emptySession(): SessionDocument {
  return {
    version: 1,
    updatedAt: Date.now(),
    activeProjectId: null,
    mode: "observe",
    lease: null,
    controlLease: null,
    adminControlLease: null,
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function leasePreset(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const preset = (value as { preset?: unknown }).preset;
  return typeof preset === "string" ? preset : undefined;
}

export class Store {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /** Ensure the state directory exists with restrictive 0700 permissions. */
  private async ensureStateDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    // mkdir with an existing dir does not retroactively chmod; best-effort
    // tighten permissions in case the directory pre-existed with a laxer mode.
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(this.stateDir, DIR_MODE);
    } catch {
      // Non-fatal: directory may be on a filesystem without POSIX perms.
    }
  }

  /**
   * Atomically write `data` (already JSON-stringified) to `filename` inside
   * the state dir: write to a sibling temp file, fsync-flush via the OS
   * write, then rename over the target. Rename is atomic within the same
   * directory/filesystem, so readers never observe a partial write.
   */
  private async atomicWriteJson(filename: string, data: unknown): Promise<void> {
    await this.ensureStateDir();
    const target = join(this.stateDir, filename);
    const tmp = join(
      this.stateDir,
      `.${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const json = JSON.stringify(data, null, 2);
    await writeFile(tmp, json, { mode: FILE_MODE, encoding: "utf8" });
    await rename(tmp, target);
  }

  private async readJson(filename: string): Promise<unknown | undefined> {
    const target = join(this.stateDir, filename);
    try {
      const raw = await readFile(target, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: failed to read/parse ${filename}: ${(err as Error).message}`,
      );
    }
  }

  async loadProjects(): Promise<ProjectRegistryEntry[]> {
    const raw = await this.readJson(PROJECTS_FILE);
    if (raw === undefined) return [];
    const parsed = ProjectsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${PROJECTS_FILE} failed validation: ${parsed.error.message}`,
      );
    }
    return parsed.data.projects;
  }

  async saveProjects(p: ProjectRegistryEntry[]): Promise<void> {
    const validated = z.array(ProjectRegistryEntrySchema).parse(p);
    const doc: ProjectsFile = {
      version: 1,
      updatedAt: Date.now(),
      projects: validated,
    };
    await this.atomicWriteJson(PROJECTS_FILE, doc);
  }

  async getSession(): Promise<SessionDocument> {
    const raw = await this.readJson(SESSIONS_FILE);
    if (raw === undefined) return emptySession();
    const parsed = SessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${SESSIONS_FILE} failed validation: ${parsed.error.message}`,
      );
    }

    // Backward-compatible migration: before controlLease existed, any active
    // control lease could only have been granted locally. Treat it as the
    // durable local authorization without forcing the owner to re-arm after
    // upgrading the runtime.
    const legacyControlLease = parsed.data.lease;
    if (!parsed.data.controlLease && legacyControlLease?.preset === "control") {
      return {
        ...parsed.data,
        controlLease: {
          ...legacyControlLease,
          preset: "control",
        },
      };
    }
    return parsed.data;
  }

  async setSession(s: unknown): Promise<void> {
    const incoming = recordOf(s);
    const current = await this.getSession();
    const incomingLease = incoming.lease;
    const explicitControlLease = Object.prototype.hasOwnProperty.call(incoming, "controlLease")
      ? incoming.controlLease
      : undefined;
    const explicitAdminControlLease = Object.prototype.hasOwnProperty.call(incoming, "adminControlLease")
      ? incoming.adminControlLease
      : undefined;

    let controlLease: unknown;
    if (explicitControlLease !== undefined) {
      controlLease = explicitControlLease;
    } else if (leasePreset(incomingLease) === "control") {
      // Only local project_select/startup can successfully create this preset.
      controlLease = incomingLease;
    } else if (incoming.activeProjectId === null && incomingLease === null) {
      // Explicit session reset (e.g. init) clears the durable local grant.
      controlLease = null;
    } else {
      // Normal preset/project changes must not silently revoke local Computer
      // Use authorization. A grant for another project remains dormant until
      // that project is active again.
      controlLease = current.controlLease;
    }

    let adminControlLease: unknown;
    if (explicitAdminControlLease !== undefined) {
      adminControlLease = explicitAdminControlLease;
    } else if (incoming.activeProjectId === null && incomingLease === null) {
      adminControlLease = null;
    } else {
      // Full/Admin control authority is a distinct lane. It may remain on
      // disk across a runtime restart, but lease-guard only recognizes it
      // while the local access mode is still Full/Admin.
      adminControlLease = current.adminControlLease;
    }

    const merged = {
      ...emptySession(),
      ...incoming,
      controlLease,
      adminControlLease,
    };
    // updatedAt is always server-recomputed, never trusted from caller input.
    merged.updatedAt = Date.now();
    const validated = SessionSchema.parse(merged);
    await this.atomicWriteJson(SESSIONS_FILE, validated);
  }
}
