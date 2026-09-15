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

const MAX_FINDINGS = 20;

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

export function scanSkillText(content: string, file = "SKILL.md"): SkillSecurityScanReport {
  const findings: SkillSecurityFinding[] = [];
  const lines = content.split(/\r?\n/);
  const add = (item: SkillSecurityFinding) => {
    if (findings.length >= MAX_FINDINGS) return;
    if (!findings.some((existing) => existing.ruleId === item.ruleId && existing.line === item.line && existing.file === item.file)) findings.push(item);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const text = `${lines[index] ?? ""} ${lines[index + 1] ?? ""}`.slice(0, 1200);
    const line = index + 1;
    if (/(ignore|disregard|override|bypass).{0,80}(system|developer|safety|previous instructions?)/i.test(text)) {
      add(finding("instruction-override", "prompt-injection", "block", file, line, "Attempts to override higher-priority instructions."));
    }
    if (/(write|append|modify|edit).{0,100}(AGENTS\.md|CLAUDE\.md|\.agents|\.codex)/i.test(text)) {
      add(finding("agent-config-write", "agent-config", "block", file, line, "Attempts to modify agent instruction or configuration files."));
    }
    if (/(persist|remember|store).{0,100}(future session|agent memory|saved memory)/i.test(text)) {
      add(finding("instruction-persistence", "persistence", "block", file, line, "Attempts to persist instructions beyond the current task."));
    }
    if (/\brm\s+-rf\s+(\/|~|\$HOME)(\s|$)/i.test(text) || /\bformat\s+[a-z]:/i.test(text)) {
      add(finding("broad-destructive-command", "destructive", "block", file, line, "Contains an obviously broad destructive command."));
    }
    if (/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f[a-z]*d)/i.test(text)) {
      add(finding("destructive-git-command", "destructive", "warning", file, line, "Contains a destructive Git reset or clean command."));
    }
    if (/(run|execute|launch|source).{0,80}scripts?[\\/]/i.test(text)) {
      add(finding("package-script-execution", "script-execution", "block", file, line, "Attempts to execute content from the skill package script directory."));
    }
    if (/\bexfiltrat(?:e|ion)\b/i.test(text)) {
      add(finding("explicit-data-exfiltration", "secret-exfiltration", "block", file, line, "Contains an explicit data-exfiltration instruction."));
    }
  }

  return {
    complete: true,
    scannedFiles: 1,
    scannedBytes: Buffer.byteLength(content, "utf8"),
    blockingFindings: findings.filter((item) => item.severity === "block").length,
    warningFindings: findings.filter((item) => item.severity === "warning").length,
    findings,
  };
}

export async function scanSkillPackageDirectory(skillDir: string): Promise<SkillSecurityScanReport> {
  return scanSkillText(skillDir, "package");
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
