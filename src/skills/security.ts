import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import type { SkillSourceProvenance } from "./install.js";

export type SkillSecurityCategory =
  | "secret-exfiltration"
  | "prompt-injection"
  | "persistence"
  | "destructive"
  | "agent-config"
  | "script-execution";

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

export const MAX_SECURITY_FINDINGS = 20;
export const MAX_SECURITY_SCAN_FILES = 128;
export const MAX_SECURITY_SCAN_BYTES = 512 * 1024;
export const MAX_SECURITY_SCAN_FILE_BYTES = 64 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".xml",
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".ps1",
  ".sh",
  ".bat",
  ".cmd",
]);

const PACKAGE_SCAN_DIRS = ["references", "templates", "assets"] as const;

interface Rule {
  ruleId: string;
  category: SkillSecurityCategory;
  severity: SkillSecuritySeverity;
  message: string;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    ruleId: "prompt-ignore-higher-priority",
    category: "prompt-injection",
    severity: "block",
    message: "Attempts to override or bypass higher-priority instructions or safety policy.",
    patterns: [
      /\b(?:ignore|disregard|override|bypass)\b.{0,100}\b(?:system|developer|higher[- ]priority|safety|policy|previous instructions?)\b/i,
      /\b(?:system|developer|higher[- ]priority|safety|policy|previous instructions?)\b.{0,100}\b(?:ignore|disregard|override|bypass)\b/i,
    ],
  },
  {
    ruleId: "prompt-expose-hidden-instructions",
    category: "prompt-injection",
    severity: "block",
    message: "Requests disclosure of hidden/system/developer instructions.",
    patterns: [
      /\b(?:reveal|print|dump|expose|show)\b.{0,100}\b(?:system prompt|developer message|hidden instructions?|internal instructions?)\b/i,
    ],
  },
  {
    ruleId: "secret-exfiltration",
    category: "secret-exfiltration",
    severity: "block",
    message: "Combines secret/credential access with instructions to transmit data externally.",
    patterns: [
      /\b(?:upload|send|post|transmit|exfiltrat(?:e|ion)|forward)\b.{0,140}\b(?:\.env|api[_ -]?key|access[_ -]?token|secret|password|credential|private key|ssh key)\b/i,
      /\b(?:\.env|api[_ -]?key|access[_ -]?token|secret|password|credential|private key|ssh key)\b.{0,140}\b(?:upload|send|post|transmit|exfiltrat(?:e|ion)|forward)\b/i,
      /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|requests\.post|fetch\s*\()\b?.{0,160}(?:\.env|\.ssh|credentials?|api[_ -]?key|token|private[_ -]?key)/i,
    ],
  },
  {
    ruleId: "persistent-agent-instruction",
    category: "persistence",
    severity: "block",
    message: "Attempts to persist instructions into agent memory/configuration for future sessions.",
    patterns: [
      /\b(?:append|write|modify|edit|inject|persist|store)\b.{0,120}\b(?:AGENTS\.md|CLAUDE\.md|agent memory|saved memory|future sessions?|persistent instructions?)\b/i,
    ],
  },
  {
    ruleId: "agent-config-modification",
    category: "agent-config",
    severity: "block",
    message: "Attempts to modify agent/runtime configuration or instruction files.",
    patterns: [
      /\b(?:append|write|modify|edit|replace|delete|remove)\b.{0,120}(?:\.agents(?:[\\/]|\b)|\.codex(?:[\\/]|\b)|AGENTS\.md|CLAUDE\.md|chatgpt2codex.{0,30}(?:config|policy))/i,
    ],
  },
  {
    ruleId: "execute-packaged-script",
    category: "script-execution",
    severity: "block",
    message: "Instructs the agent to execute content from the skill package scripts directory.",
    patterns: [
      /\b(?:run|execute|launch|source|invoke)\b.{0,100}(?:scripts?[\\/][^\s`'\"]+)/i,
      /(?:\.\/)?scripts?[\\/][^\s`'\"]+\.(?:sh|ps1|py|js|bat|cmd)\b/i,
    ],
  },
  {
    ruleId: "destructive-filesystem-command",
    category: "destructive",
    severity: "block",
    message: "Contains an obviously broad destructive filesystem command.",
    patterns: [
      /\brm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/i,
      /\bformat(?:\.com)?\s+[a-z]:/i,
      /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i,
      /\bRemove-Item\b.{0,100}\b-Recurse\b.{0,100}\b-Force\b.{0,100}(?:[a-z]:\\|\$HOME|~)/i,
    ],
  },
  {
    ruleId: "destructive-git-command",
    category: "destructive",
    severity: "warning",
    message: "Contains a destructive Git reset/clean command that should require task-specific justification.",
    patterns: [
      /\bgit\s+reset\s+--hard\b/i,
      /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*\b/i,
    ],
  },
];

function summarize(findings: SkillSecurityFinding[], complete = true, scannedFiles = 1, scannedBytes = 0): SkillSecurityScanReport {
  return {
    complete,
    scannedFiles,
    scannedBytes,
    blockingFindings: findings.filter((finding) => finding.severity === "block").length,
    warningFindings: findings.filter((finding) => finding.severity === "warning").length,
    findings: findings.slice(0, MAX_SECURITY_FINDINGS),
  };
}

function pushFinding(findings: SkillSecurityFinding[], finding: SkillSecurityFinding): void {
  if (findings.length >= MAX_SECURITY_FINDINGS) return;
  if (findings.some((item) => item.ruleId === finding.ruleId && item.file === finding.file && item.line === finding.line)) return;
  findings.push(finding);
}

export function scanSkillText(content: string, file = "SKILL.md"): SkillSecurityScanReport {
  const findings: SkillSecurityFinding[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    const window = `${current} ${next}`.slice(0, 1200);
    for (const rule of RULES) {
      if (!rule.patterns.some((pattern) => pattern.test(window))) continue;
      pushFinding(findings, {
        ruleId: rule.ruleId,
        category: rule.category,
        severity: rule.severity,
        file,
        line: index + 1,
        message: rule.message,
      });
    }
  }

  return summarize(findings, true, 1, Buffer.byteLength(content, "utf8"));
}

function isTextCandidate(fileName: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function mergeFindings(target: SkillSecurityFinding[], source: SkillSecurityFinding[]): void {
  for (const finding of source) pushFinding(target, finding);
}

export async function scanSkillPackageDirectory(skillDir: string): Promise<SkillSecurityScanReport> {
  const findings: SkillSecurityFinding[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let complete = true;

  const scanFile = async (filePath: string, relativePath: string): Promise<void> => {
    if (scannedFiles >= MAX_SECURITY_SCAN_FILES || scannedBytes >= MAX_SECURITY_SCAN_BYTES) {
      complete = false;
      return;
    }
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      complete = false;
      return;
    }
    if (info.size > MAX_SECURITY_SCAN_FILE_BYTES || scannedBytes + info.size > MAX_SECURITY_SCAN_BYTES) {
      complete = false;
      return;
    }
    const content = await readFile(filePath, "utf8");
    scannedFiles += 1;
    scannedBytes += info.size;
    mergeFindings(findings, scanSkillText(content, relativePath).findings);
  };

  await scanFile(path.join(skillDir, "SKILL.md"), "SKILL.md");

  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    if (scannedFiles >= MAX_SECURITY_SCAN_FILES || scannedBytes >= MAX_SECURITY_SCAN_BYTES) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (scannedFiles >= MAX_SECURITY_SCAN_FILES || scannedBytes >= MAX_SECURITY_SCAN_BYTES) {
        complete = false;
        break;
      }
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      const child = path.join(dir, entry.name);
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await walk(child, relative);
      } else if (entry.isFile() && isTextCandidate(entry.name)) {
        await scanFile(child, relative);
      }
    }
  };

  for (const dirName of PACKAGE_SCAN_DIRS) {
    await walk(path.join(skillDir, dirName), dirName);
  }

  return summarize(findings, complete, scannedFiles, scannedBytes);
}

export function describeSkillTrust(provenance: SkillSourceProvenance | null): SkillTrustReport {
  if (!provenance) {
    return { level: "unmanaged", managed: false, external: false };
  }
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

export function assertExternalSkillSecurity(
  trust: SkillTrustReport,
  scan: SkillSecurityScanReport,
  operation: string,
): void {
  if (!trust.external) return;
  if (!scan.complete) {
    throw new DomainError(
      ErrorCode.SCAN_DENIED,
      `External Agent Skill security scan was incomplete; refusing ${operation}`,
    );
  }
  if (scan.blockingFindings > 0) {
    const rules = [...new Set(scan.findings.filter((item) => item.severity === "block").map((item) => item.ruleId))];
    throw new DomainError(
      ErrorCode.SCAN_DENIED,
      `External Agent Skill blocked by static security scan during ${operation}: ${rules.join(", ")}`,
      { rules },
    );
  }
}
