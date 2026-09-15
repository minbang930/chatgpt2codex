import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import type { SkillSourceProvenance } from "./install.js";

export type SkillSecurityCategory = "secret-exfiltration" | "prompt-injection" | "persistence" | "destructive" | "agent-config" | "script-execution";
export type SkillSecuritySeverity = "warning" | "block";

export interface SkillSecurityFinding {
  ruleId: string;
  category: SkillSecurityCategory;
  severity: SkillSecuritySeverity;
  file: string;
  line: number;
  message: string;
}

export interface SkillSecurityScanReport {
  complete: boolean;
  scannedFiles: number;
  scannedBytes: number;
  blockingFindings: number;
  warningFindings: number;
  findings: SkillSecurityFinding[];
}

export type SkillTrustLevel = "unmanaged" | "managed-local" | "external-git";
export interface SkillTrustReport {
  level: SkillTrustLevel;
  managed: boolean;
  external: boolean;
  sourceKind?: "local" | "git";
  source?: string;
  requestedRef?: string;
  resolvedCommit?: string;
  installedAt?: string;
  updatedAt?: string;
}

export const MAX_SECURITY_SCAN_FILES = 128;
export const MAX_SECURITY_SCAN_BYTES = 512 * 1024;
export const MAX_SECURITY_SCAN_FILE_BYTES = 64 * 1024;
const MAX_FINDINGS = 20;
const PACKAGE_SCAN_DIRS = ["references", "templates", "assets"] as const;
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".csv", ".xml", ".html", ".htm"]);

function finding(
  ruleId: string,
  category: SkillSecurityCategory,
  severity: SkillSecuritySeverity,
  file: string,
  line: number,
  message: string,
): SkillSecurityFinding {
  return { ruleId, category, severity, file, line, message };
}

function addFinding(findings: SkillSecurityFinding[], item: SkillSecurityFinding): void {
  if (findings.length >= MAX_FINDINGS) return;
  if (!findings.some((existing) => existing.ruleId === item.ruleId && existing.line === item.line && existing.file === item.file)) findings.push(item);
}

function summarize(findings: SkillSecurityFinding[], complete: boolean, scannedFiles: number, scannedBytes: number): SkillSecurityScanReport {
  return {
    complete,
    scannedFiles,
    scannedBytes,
    blockingFindings: findings.filter((item) => item.severity === "block").length,
    warningFindings: findings.filter((item) => item.severity === "warning").length,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

export function scanSkillText(content: string, file = "SKILL.md"): SkillSecurityScanReport {
  const findings: SkillSecurityFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = `${lines[index] ?? ""} ${lines[index + 1] ?? ""}`.slice(0, 1200);
    const line = index + 1;
    if (/(ignore|disregard|override|bypass).{0,80}(system|developer|safety|previous instructions?)/i.test(text)) {
      addFinding(findings, finding("instruction-override", "prompt-injection", "block", file, line, "Attempts to override higher-priority instructions."));
    }
    if (/(write|append|modify|edit).{0,100}(AGENTS\.md|CLAUDE\.md|\.agents|\.codex)/i.test(text)) {
      addFinding(findings, finding("agent-config-write", "agent-config", "block", file, line, "Attempts to modify agent instruction or configuration files."));
    }
    if (/(persist|remember|store).{0,100}(future session|agent memory|saved memory)/i.test(text)) {
      addFinding(findings, finding("instruction-persistence", "persistence", "block", file, line, "Attempts to persist instructions beyond the current task."));
    }
    if (/\brm\s+-rf\s+(\/|~|\$HOME)(\s|$)/i.test(text) || /\bformat\s+[a-z]:/i.test(text)) {
      addFinding(findings, finding("broad-destructive-command", "destructive", "block", file, line, "Contains an obviously broad destructive command."));
    }
    if (/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f[a-z]*d)/i.test(text)) {
      addFinding(findings, finding("destructive-git-command", "destructive", "warning", file, line, "Contains a destructive Git reset or clean command."));
    }
    if (/(run|execute|launch|source).{0,80}scripts?[\\/]/i.test(text)) {
      addFinding(findings, finding("package-script-execution", "script-execution", "block", file, line, "Attempts to execute content from the skill package script directory."));
    }
    if (/\bexfiltrat(?:e|ion)\b/i.test(text)) {
      addFinding(findings, finding("explicit-data-exfiltration", "secret-exfiltration", "block", file, line, "Contains an explicit data-exfiltration instruction."));
    }
  }
  return summarize(findings, true, 1, Buffer.byteLength(content, "utf8"));
}

export async function scanSkillPackageDirectory(skillDir: string): Promise<SkillSecurityScanReport> {
  const findings: SkillSecurityFinding[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let complete = true;

  const scanFile = async (filePath: string, relativePath: string): Promise<void> => {
    if (scannedFiles >= MAX_SECURITY_SCAN_FILES || scannedBytes >= MAX_SECURITY_SCAN_BYTES) { complete = false; return; }
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) { complete = false; return; }
    if (info.size > MAX_SECURITY_SCAN_FILE_BYTES || scannedBytes + info.size > MAX_SECURITY_SCAN_BYTES) { complete = false; return; }
    const nested = scanSkillText(await readFile(filePath, "utf8"), relativePath);
    scannedFiles += 1;
    scannedBytes += info.size;
    for (const item of nested.findings) addFinding(findings, item);
  };

  await scanFile(path.join(skillDir, "SKILL.md"), "SKILL.md");

  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (scannedFiles >= MAX_SECURITY_SCAN_FILES || scannedBytes >= MAX_SECURITY_SCAN_BYTES) { complete = false; break; }
      if (entry.isSymbolicLink()) { complete = false; continue; }
      const child = path.join(dir, entry.name);
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) await walk(child, relative);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) await scanFile(child, relative);
    }
  };

  for (const dirName of PACKAGE_SCAN_DIRS) await walk(path.join(skillDir, dirName), dirName);
  return summarize(findings, complete, scannedFiles, scannedBytes);
}

export function describeSkillTrust(provenance: SkillSourceProvenance | null): SkillTrustReport {
  if (!provenance) return { level: "unmanaged", managed: false, external: false };
  return {
    level: provenance.sourceKind === "git" ? "external-git" : "managed-local",
    managed: true,
    external: provenance.sourceKind === "git",
    sourceKind: provenance.sourceKind,
    source: provenance.source,
    requestedRef: provenance.requestedRef,
    resolvedCommit: provenance.resolvedCommit,
    installedAt: provenance.installedAt,
    updatedAt: provenance.updatedAt,
  };
}

export function assertExternalSkillSecurity(trust: SkillTrustReport, scan: SkillSecurityScanReport, operation: string): void {
  if (!trust.external) return;
  if (!scan.complete || scan.blockingFindings > 0) {
    throw new DomainError(ErrorCode.SCAN_DENIED, `External Agent Skill failed static validation during ${operation}`);
  }
}
