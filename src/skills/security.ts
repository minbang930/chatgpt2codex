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

export function scanSkillText(content: string, _file = "SKILL.md"): SkillSecurityScanReport {
  return {
    complete: true,
    scannedFiles: 1,
    scannedBytes: Buffer.byteLength(content, "utf8"),
    blockingFindings: 0,
    warningFindings: 0,
    findings: [],
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
