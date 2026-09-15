import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseSkillDocument } from "./parser.js";
import type { LoadedSkill, SkillDiagnostic, SkillMetadata, SkillScope } from "./types.js";

export const MAX_SKILL_FILE_BYTES = 256 * 1024;

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
