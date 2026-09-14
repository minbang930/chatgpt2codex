import { DomainError, ErrorCode } from "../types.js";
import type { ResolvedTargetPreview } from "./queue.js";
import * as macInput from "./mac-input.js";
import * as winInput from "./win-input.js";

export interface SemanticTarget {
  role: string;
  title?: string;
  label?: string;
  description?: string;
}

export function supportsNativeDesktopInput(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

export function supportsSemanticTargeting(): boolean {
  return process.platform === "darwin";
}

function unsupported(): never {
  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    `Desktop control synthetic input is not supported on ${process.platform}`,
  );
}

export async function resolveFrontmostApp(): Promise<string | undefined> {
  if (process.platform === "darwin") return macInput.resolveFrontmostApp();
  if (process.platform === "win32") return winInput.resolveFrontmostApp();
  return undefined;
}

export async function resolveWindowPoint(appName: string, xRel: number, yRel: number): Promise<{ x: number; y: number }> {
  if (process.platform === "darwin") return macInput.resolveWindowPoint(appName, xRel, yRel);
  if (process.platform === "win32") return winInput.resolveWindowPoint(appName, xRel, yRel);
  return unsupported();
}

export async function clickAtPoint(appName: string, x: number, y: number): Promise<void> {
  if (process.platform === "darwin") return macInput.clickAtPoint(appName, x, y);
  if (process.platform === "win32") return winInput.clickAtPoint(appName, x, y);
  return unsupported();
}

export async function typeText(appName: string, text: string): Promise<void> {
  if (process.platform === "darwin") return macInput.typeText(appName, text);
  if (process.platform === "win32") return winInput.typeText(appName, text);
  return unsupported();
}

/**
 * `keyCode` keeps the existing macOS virtual-key-code wire semantics. The
 * Windows backend translates that value to the matching Win32 virtual key.
 */
export async function pressKey(appName: string, keyCode: number): Promise<void> {
  if (process.platform === "darwin") return macInput.pressKey(appName, keyCode);
  if (process.platform === "win32") return winInput.pressKey(appName, keyCode);
  return unsupported();
}

export async function resolveAxElement(appName: string, target: SemanticTarget): Promise<ResolvedTargetPreview> {
  if (process.platform === "darwin") return macInput.resolveAxElement(appName, target);
  if (process.platform === "win32") {
    return {
      found: false,
      reason: "Windows semantic UIA targeting is not implemented yet; provide windowPoint for the M3.1 fallback path",
    };
  }
  return { found: false, reason: `Semantic targeting is not supported on ${process.platform}` };
}

export async function pressAxElement(appName: string, target: SemanticTarget): Promise<void> {
  if (process.platform === "darwin") return macInput.pressAxElement(appName, target);
  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    "Semantic accessibility press is not implemented on Windows yet; use a windowPoint fallback",
  );
}

export async function setAxValue(appName: string, target: SemanticTarget, text: string): Promise<void> {
  if (process.platform === "darwin") return macInput.setAxValue(appName, target, text);
  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    "Semantic accessibility value setting is not implemented on Windows yet; use a windowPoint fallback",
  );
}

export function preflightPermissions(): ReturnType<typeof macInput.preflightPermissions> {
  if (process.platform === "darwin") return macInput.preflightPermissions();
  return Promise.resolve({
    accessibilityTrusted: true,
    screenRecordingAllowed: false,
    source: "unavailable" as const,
    reason: "macOS Accessibility preflight does not apply on this platform",
  });
}
