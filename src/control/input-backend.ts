import { DomainError, ErrorCode } from "../types.js";
import type { ResolvedTargetPreview } from "./queue.js";
import { withComputerUseActivity } from "./activity-indicator.js";
import * as macInput from "./mac-input.js";
import * as winInput from "./win-native.js";
import * as winUia from "./win-uia.js";

export interface SemanticTarget {
  role: string;
  title?: string;
  label?: string;
  description?: string;
}

export type VisibleAppWindow = winInput.VisibleAppWindow;
export type WindowsUiaObservation = winUia.WindowsUiaObservation;

export function supportsNativeDesktopInput(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

export function supportsSemanticTargeting(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
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

/** Windows-only M3 observation primitive. Returned window ids are ephemeral
 * observation labels; actions continue to re-resolve by allowlisted app. */
export async function listVisibleWindows(): Promise<VisibleAppWindow[]> {
  if (process.platform === "win32") return winInput.listVisibleWindows();
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Read-only top-level window observation is currently supported on Windows");
}

/** Bounded Windows ControlView snapshot. Each returned element carries an
 * opaque observation-scoped selector that can be passed unchanged through
 * the existing target.ax contract; the UIA helper never exports HWNDs or
 * runtime-id authority. */
export async function snapshotSemanticElements(
  appName: string,
  options: { maxElements?: number; maxDepth?: number } = {},
): Promise<WindowsUiaObservation> {
  if (process.platform === "win32") return winUia.snapshotSemanticElements(appName, options);
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Semantic UI snapshots are currently supported on Windows");
}

export async function resolveWindowPoint(appName: string, xRel: number, yRel: number): Promise<{ x: number; y: number }> {
  if (process.platform === "darwin") return macInput.resolveWindowPoint(appName, xRel, yRel);
  if (process.platform === "win32") return winInput.resolveWindowPoint(appName, xRel, yRel);
  return unsupported();
}

export async function clickAtPoint(appName: string, x: number, y: number): Promise<void> {
  if (process.platform === "darwin") return macInput.clickAtPoint(appName, x, y);
  if (process.platform === "win32") {
    return withComputerUseActivity(() => winInput.clickAtPoint(appName, x, y));
  }
  return unsupported();
}

export async function typeText(appName: string, text: string): Promise<void> {
  if (process.platform === "darwin") return macInput.typeText(appName, text);
  if (process.platform === "win32") {
    return withComputerUseActivity(() => winInput.typeText(appName, text));
  }
  return unsupported();
}

/**
 * `keyCode` keeps the existing macOS virtual-key-code wire semantics. The
 * Windows backend translates that value to the matching Win32 virtual key.
 */
export async function pressKey(appName: string, keyCode: number): Promise<void> {
  if (process.platform === "darwin") return macInput.pressKey(appName, keyCode);
  if (process.platform === "win32") {
    return withComputerUseActivity(() => winInput.pressKey(appName, keyCode));
  }
  return unsupported();
}

/** Resolve a semantic target read-only at request/approval time. macOS keeps
 * its AX role/title resolver. Windows accepts only an observation-scoped UIA
 * selector emitted by snapshotSemanticElements and re-resolves it against
 * the current target window. */
export async function resolveAxElement(appName: string, target: SemanticTarget): Promise<ResolvedTargetPreview> {
  if (process.platform === "darwin") return macInput.resolveAxElement(appName, target);
  if (process.platform === "win32") return winUia.resolveSemanticElement(appName, target);
  return { found: false, reason: `Semantic targeting is not supported on ${process.platform}` };
}

/** Existing executor click path. On Windows the semantic press chooses the
 * strongest reliable UIA operation exposed by the element: InvokePattern,
 * SelectionItemPattern.Select, then SetFocus. executor.ts preserves the
 * existing windowPoint fallback if that semantic operation cannot run. */
export async function pressAxElement(appName: string, target: SemanticTarget): Promise<void> {
  if (process.platform === "darwin") return macInput.pressAxElement(appName, target);
  if (process.platform === "win32") {
    return withComputerUseActivity(() => winUia.pressSemanticElement(appName, target));
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Semantic accessibility press is not supported on this platform");
}

/** Existing executor type path. Windows focuses the re-resolved element and
 * uses ValuePattern.SetValue when writable; executor.ts falls back to its
 * coordinate click + Unicode typing path when ValuePattern is unavailable. */
export async function setAxValue(appName: string, target: SemanticTarget, text: string): Promise<void> {
  if (process.platform === "darwin") return macInput.setAxValue(appName, target, text);
  if (process.platform === "win32") {
    return withComputerUseActivity(() => winUia.setSemanticValue(appName, target, text));
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Semantic accessibility value setting is not supported on this platform");
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
