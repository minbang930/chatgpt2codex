import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { parseSkillDocument } from "./parser.js";
import type { LoadedSkill, SkillDiagnostic, SkillMetadata, SkillScope } from "./types.js";

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_RESOURCE_BYTES = 128 * 1024;
export const ALLOWED_SKILL_RESOURCE_DIRS = ["references", "templates", "assets"] as const;
export type SkillResourceKind = (typeof ALLOWED_SKILL_RESOURCE_DIRS)[number];

export interface SkillResourceReadResult {
  path: string;
  kind: SkillResourceKind;
  byteLength: number;
  encoding: "utf8" | "base64";
  content: string;
}

const ALLOWED_RESOURCE_DIR_SET = new Set<string>(ALLOWED_SKILL_RESOURCE_DIRS);

function isInsideRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function validateSkillPath(rootDir: string, skillDir: string): Promise<{ rootRealPath: string; skillRealPath: string }> {
  const [rootRealPath, skillRealPath] = await Promise.all([realpath(rootDir), realpath(skillDir)]);
  if (!isInsideRoot(rootRealPath, skillRealPath)) {
    throw new Error("skill directory escapes its configured skill root");
  }
  return { rootRealPath, skillRealPath };
}

export async function loadSkillDirectory(params: {
  rootDir: string;
  skillDir: string;
  scope: SkillScope;
}): Promise<{ skill?: LoadedSkill; diagnostic?: SkillDiagnostic }> {
  const skillFile = path.join(params.skillDir, "SKILL.md");
  try {
    const { rootRealPath, skillRealPath } = await validateSkillPath(params.rootDir, params.skillDir);
    const dirInfo = await lstat(params.skillDir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      return {
        diagnostic: {
          kind: "unsafe",
          path: params.skillDir,
          message: "skill directory must be a real directory, not a symlink",
        },
      };
    }

    const fileInfo = await lstat(skillFile);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      return {
        diagnostic: {
          kind: "unsafe",
          path: skillFile,
          message: "SKILL.md must be a regular file, not a symlink",
        },
      };
    }
    if (fileInfo.size > MAX_SKILL_FILE_BYTES) {
      return {
        diagnostic: {
          kind: "limit",
          path: skillFile,
          message: `SKILL.md exceeds the ${MAX_SKILL_FILE_BYTES}-byte limit`,
        },
      };
    }

    const skillFileRealPath = await realpath(skillFile);
    if (!isInsideRoot(rootRealPath, skillFileRealPath) || !isInsideRoot(skillRealPath, skillFileRealPath)) {
      return {
        diagnostic: {
          kind: "unsafe",
          path: skillFile,
          message: "SKILL.md resolves outside its configured skill directory",
        },
      };
    }

    const content = await readFile(skillFile, "utf8");
    const parsed = parseSkillDocument(content);
    return {
      skill: {
        ...parsed,
        content,
        scope: params.scope,
        baseDir: skillRealPath,
        filePath: skillFileRealPath,
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const missing = code === "ENOENT" || code === "ENOTDIR";
    return {
      diagnostic: {
        kind: missing ? "missing" : error instanceof Error && /escape|symlink|outside/i.test(error.message) ? "unsafe" : "invalid",
        path: skillFile,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function loadSkillMetadata(params: {
  rootDir: string;
  skillDir: string;
  scope: SkillScope;
}): Promise<{ metadata?: SkillMetadata; diagnostic?: SkillDiagnostic }> {
  const loaded = await loadSkillDirectory(params);
  if (!loaded.skill) return { diagnostic: loaded.diagnostic };
  const { name, description, scope, baseDir, filePath } = loaded.skill;
  return { metadata: { name, description, scope, baseDir, filePath } };
}

export async function skillDirectoryExists(skillDir: string): Promise<boolean> {
  try {
    return (await stat(skillDir)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeSkillResourcePath(resourcePath: string): {
  normalized: string;
  kind: SkillResourceKind;
  segments: string[];
} {
  const raw = resourcePath.trim();
  if (!raw) throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Skill resource path must not be empty");
  if (raw.includes("\0") || path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Skill resource path must be relative to the skill package");
  }
  const segments = raw.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Skill resource path contains an unsafe path segment");
  }
  const kind = segments[0];
  if (!kind || !ALLOWED_RESOURCE_DIR_SET.has(kind)) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      `Skill resources may only be read from ${ALLOWED_SKILL_RESOURCE_DIRS.join(", ")}`,
    );
  }
  if (segments.length < 2) {
    throw new DomainError(ErrorCode.NOT_A_FILE, "Skill resource path must name a file inside an allowed resource directory");
  }
  return { normalized: segments.join("/"), kind: kind as SkillResourceKind, segments };
}

function encodeSkillResource(buffer: Buffer): { encoding: "utf8" | "base64"; content: string } {
  const text = buffer.toString("utf8");
  if (!text.includes("\u0000") && Buffer.from(text, "utf8").equals(buffer)) {
    return { encoding: "utf8", content: text };
  }
  return { encoding: "base64", content: buffer.toString("base64") };
}

export async function readSkillResource(skill: LoadedSkill, resourcePath: string): Promise<SkillResourceReadResult> {
  const parsed = normalizeSkillResourcePath(resourcePath);
  const skillRealPath = await realpath(skill.baseDir);
  const resourceRoot = path.join(skillRealPath, parsed.kind);

  let resourceRootInfo;
  try {
    resourceRootInfo = await lstat(resourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Skill resource directory does not exist: ${parsed.kind}`);
    }
    throw error;
  }
  if (!resourceRootInfo.isDirectory() || resourceRootInfo.isSymbolicLink()) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "Skill resource directory must be a real directory, not a symlink");
  }

  const resourceRootRealPath = await realpath(resourceRoot);
  if (!isInsideRoot(skillRealPath, resourceRootRealPath)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Skill resource directory resolves outside the skill package");
  }

  const target = path.join(skillRealPath, ...parsed.segments);
  let targetInfo;
  try {
    targetInfo = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Skill resource not found: ${parsed.normalized}`);
    }
    throw error;
  }
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
    throw new DomainError(ErrorCode.NOT_A_FILE, `Skill resource must be a regular non-symlink file: ${parsed.normalized}`);
  }
  if (targetInfo.size > MAX_SKILL_RESOURCE_BYTES) {
    throw new DomainError(
      ErrorCode.FILE_TOO_LARGE,
      `Skill resource exceeds the ${MAX_SKILL_RESOURCE_BYTES}-byte read limit`,
      { byteLength: targetInfo.size, maxBytes: MAX_SKILL_RESOURCE_BYTES },
    );
  }

  const targetRealPath = await realpath(target);
  if (!isInsideRoot(skillRealPath, targetRealPath) || !isInsideRoot(resourceRootRealPath, targetRealPath)) {
    throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "Skill resource resolves outside its allowed resource directory");
  }

  const buffer = await readFile(targetRealPath);
  const encoded = encodeSkillResource(buffer);
  return {
    path: parsed.normalized,
    kind: parsed.kind,
    byteLength: buffer.byteLength,
    encoding: encoded.encoding,
    content: encoded.content,
  };
}
