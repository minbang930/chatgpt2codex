import { DomainError, ErrorCode } from "../types.js";
import type { ResolvedTargetPreview } from "./queue.js";
import { withComputerUseActivity } from "./activity-indicator.js";
import * as macInput from "./mac-input.js";
import * as winInput from "./win-native.js";
import * as winUia from "./win-uia.js";
import * as cuaInput from "./cua-driver.js";
import { isCuaWindowsBackend } from "./windows-backend-mode.js";

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
  if (process.platform === "win32") {
    return isCuaWindowsBackend() ? cuaInput.resolveFrontmostApp() : winInput.resolveFrontmostApp();
  }
  return undefined;
}

/** Windows-only observation primitive. The public shape stays backend-neutral:
 * legacy uses the local Win32 helper while the optional Cua backend maps
 * cua-driver window rows into the same ephemeral observation records. */
export async function listVisibleWindows(): Promise<VisibleAppWindow[]> {
  if (process.platform === "win32") {
    return isCuaWindowsBackend() ? cuaInput.listVisibleWindows() : winInput.listVisibleWindows();
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Read-only top-level window observation is currently supported on Windows");
}

/** Bounded Windows semantic snapshot. Cua element tokens are wrapped in the
 * existing target.ax wire shape, so queue/approval/audit contracts do not
 * change when the backend is switched. */
export async function snapshotSemanticElements(
  appName: string,
  options: { maxElements?: number; maxDepth?: number } = {},
): Promise<WindowsUiaObservation> {
  if (process.platform === "win32") {
    return isCuaWindowsBackend()
      ? cuaInput.snapshotSemanticElements(appName, options)
      : winUia.snapshotSemanticElements(appName, options);
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Semantic UI snapshots are currently supported on Windows");
}

export async function resolveWindowPoint(appName: string, xRel: number, yRel: number): Promise<{ x: number; y: number }> {
  if (process.platform === "darwin") return macInput.resolveWindowPoint(appName, xRel, yRel);
  if (process.platform === "win32") {
    return isCuaWindowsBackend()
      ? cuaInput.resolveWindowPoint(appName, xRel, yRel)
      : winInput.resolveWindowPoint(appName, xRel, yRel);
  }
  return unsupported();
}

export async function clickAtPoint(appName: string, x: number, y: number): Promise<void> {
  if (process.platform === "darwin") return macInput.clickAtPoint(appName, x, y);
  if (process.platform === "win32") {
    return withComputerUseActivity(() =>
      isCuaWindowsBackend() ? cuaInput.clickAtPoint(appName, x, y) : winInput.clickAtPoint(appName, x, y),
    );
  }
  return unsupported();
}

export async function typeText(appName: string, text: string): Promise<void> {
  if (process.platform === "darwin") return macInput.typeText(appName, text);
  if (process.platform === "win32") {
    return withComputerUseActivity(() =>
      isCuaWindowsBackend() ? cuaInput.typeText(appName, text) : winInput.typeText(appName, text),
    );
  }
  return unsupported();
}

/**
 * keyCode keeps the existing macOS virtual-key-code wire semantics. Each
 * Windows backend translates that legacy namespace at its own boundary.
 */
export async function pressKey(appName: string, keyCode: number): Promise<void> {
  if (process.platform === "darwin") return macInput.pressKey(appName, keyCode);
  if (process.platform === "win32") {
    return withComputerUseActivity(() =>
      isCuaWindowsBackend() ? cuaInput.pressKey(appName, keyCode) : winInput.pressKey(appName, keyCode),
    );
  }
  return unsupported();
}

/** Resolve a semantic target read-only at request/approval time. */
export async function resolveAxElement(appName: string, target: SemanticTarget): Promise<ResolvedTargetPreview> {
  if (process.platform === "darwin") return macInput.resolveAxElement(appName, target);
  if (process.platform === "win32") {
    return isCuaWindowsBackend()
      ? cuaInput.resolveSemanticElement(appName, target)
      : winUia.resolveSemanticElement(appName, target);
  }
  return { found: false, reason: `Semantic targeting is not supported on ${process.platform}` };
}

/** Execute the strongest semantic click available in the selected backend.
 * The Cua adapter uses background delivery first and only escalates when the
 * Driver explicitly reports background_unavailable. */
export async function pressAxElement(appName: string, target: SemanticTarget): Promise<void> {
  if (process.platform === "darwin") return macInput.pressAxElement(appName, target);
  if (process.platform === "win32") {
    return withComputerUseActivity(() =>
      isCuaWindowsBackend()
        ? cuaInput.pressSemanticElement(appName, target)
        : winUia.pressSemanticElement(appName, target),
    );
  }
  throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Semantic accessibility press is not supported on this platform");
}

/** Existing executor type path. Both Windows backends preserve the same
 * semantic-first then coordinate fallback contract. */
export async function setAxValue(appName: string, target: SemanticTarget, text: string): Promise<void> {
  if (process.platform === "darwin") return macInput.setAxValue(appName, target, text);
  if (process.platform === "win32") {
    return withComputerUseActivity(() =>
      isCuaWindowsBackend()
        ? cuaInput.setSemanticValue(appName, target, text)
        : winUia.setSemanticValue(appName, target, text),
    );
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
