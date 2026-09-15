export type SkillScope = "project" | "global";

export type SkillFrontmatterValue = string | string[];

export interface ParsedSkillDocument {
  name: string;
  description: string;
  frontmatter: Record<string, SkillFrontmatterValue>;
  body: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  scope: SkillScope;
  baseDir: string;
  filePath: string;
}

export interface LoadedSkill extends SkillMetadata, ParsedSkillDocument {
  content: string;
}

export type SkillDiagnosticKind =
  | "missing"
  | "invalid"
  | "unsafe"
  | "read"
  | "limit"
  | "collision";

export interface SkillDiagnostic {
  kind: SkillDiagnosticKind;
  path: string;
  message: string;
}

export interface SkillRegistrySnapshot {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
}
