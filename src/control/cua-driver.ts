import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DomainError, ErrorCode } from "../types.js";
import { cuaToolResultError } from "./cua-driver-error.js";
import { resolveCuaDriverCommand } from "./cua-driver-command.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";
import type { ResolvedTargetPreview } from "./queue.js";
import type { VisibleAppWindow } from "./win-native.js";
import type {
  WindowsUiaElement,
  WindowsUiaObservation,
  WindowsUiaSelector,
} from "./win-uia.js";

interface CuaConnection {
  client: Client;
  transport: StdioClientTransport;
}

interface RawWindow {
  pid?: number;
  window_id?: number;
  app_name?: string;
  title?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  z_index?: number | null;
  is_on_screen?: boolean;
  minimized?: boolean;
}

interface ResolvedWindow {
  pid: number;
  windowId: number;
  appName: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  zIndex?: number;
  onScreen: boolean;
  minimized: boolean;
}

interface CuaElementRef {
  version: 1;
  pid: number;
  windowId: number;
  snapshotId: string;
  elementToken?: string;
  elementIndex?: number;
  role: string;
  title?: string;
}

interface CachedObservation {
  appKey: string;
  target: ResolvedWindow;
  observation: WindowsUiaObservation;
  screenshotScale: number;
  storedAt: number;
}

export interface CuaDriverActionDiagnostic {
  tool: string;
  deliveryMode?: "background" | "foreground" | "semantic";
  effect?: string;
  route?: string;
  verified?: boolean;
  escalation?: string;
}

export interface CuaDriverToolTiming {
  calls: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
}

export interface CuaDriverDiagnostics {
  calls: number;
  backgroundAttempts: number;
  foregroundEscalations: number;
  failures: number;
  confirmedActions: number;
  unverifiableActions: number;
  suspectedNoops: number;
  observationCacheHits: number;
  observationNormalizations: number;
  observationNormalizeTotalMs: number;
  targetResolutions: number;
  targetResolveTotalMs: number;
  targetCacheHits: number;
  targetCacheMisses: number;
  toolTimings: Record<string, CuaDriverToolTiming>;
  recentActions: CuaDriverActionDiagnostic[];
}

export interface CuaAppScreenshot {
  path: string;
  appName: string;
  title?: string;
  width: number;
  height: number;
  dpi: number;
  scaleFactor: number;
  captureMethod: "cua-driver";
}

const DEFAULT_DPI = 96;
const OBSERVATION_CACHE_MS = 10_000;
const TARGET_CACHE_MS = 2_000;
const SESSION = `chatgpt2codex-${process.pid}`;
const CUAREF_PREFIX = "cuaref:";

let connectionPromise: Promise<CuaConnection> | undefined;
const observationCache = new Map<string, CachedObservation>();
const targetCache = new Map<string, { target: ResolvedWindow; storedAt: number }>();
const diagnostics: CuaDriverDiagnostics = {
  calls: 0,
  backgroundAttempts: 0,
  foregroundEscalations: 0,
  failures: 0,
  confirmedActions: 0,
  unverifiableActions: 0,
  suspectedNoops: 0,
  observationCacheHits: 0,
  observationNormalizations: 0,
  observationNormalizeTotalMs: 0,
  targetResolutions: 0,
  targetResolveTotalMs: 0,
  targetCacheHits: 0,
  targetCacheMisses: 0,
  toolTimings: {},
  recentActions: [],
};

function defaultCursorOverlayEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.CHATGPT2CODEX_CUA_CURSOR_OVERLAY?.trim() ?? "");
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Cua Driver desktop backend is Windows-only in chatgpt2codex");
  }
}

function safeChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildSafeChildEnv())) {
    if (value !== undefined) env[key] = value;
  }
  // Cua Driver product telemetry is not needed for the local adapter or A/B
  // benchmark and would widen the network/privacy surface of chatgpt2codex.
  env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
  return env;
}

async function connect(): Promise<CuaConnection> {
  assertWindows();
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const resolvedDriver = resolveCuaDriverCommand();
      const transport = new StdioClientTransport({
        command: resolvedDriver.command,
        args: ["mcp"],
        env: safeChildEnv(),
        stderr: "pipe",
      });
      const client = new Client({ name: "chatgpt2codex-cua-adapter", version: "0.1.0" });
      try {
        await client.connect(transport);
        // The synthetic Cua cursor is a visualization feature, not part of
        // semantic/background actuation. Keep it off by default so its awaited
        // glide animation cannot sit on the production action critical path.
        // Demos can opt back in with CHATGPT2CODEX_CUA_CURSOR_OVERLAY=1.
        const cursorResult = await client.callTool({
          name: "set_agent_cursor_enabled",
          arguments: { session: SESSION, enabled: defaultCursorOverlayEnabled() },
        });
        const cursorStructured = cursorResult.structuredContent as Record<string, unknown> | undefined;
        if (cursorResult.isError || !cursorStructured) {
          throw resultError("set_agent_cursor_enabled", cursorResult, cursorStructured);
        }
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw new DomainError(
          ErrorCode.NOT_IMPLEMENTED,
          `Cua Driver backend is unavailable. Install cua-driver or set CUA_DRIVER_BIN. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { client, transport };
    })();
  }

  try {
    return await connectionPromise;
  } catch (error) {
    connectionPromise = undefined;
    throw error;
  }
}

function resultError(name: string, result: unknown, structured: Record<string, unknown> | undefined): Error {
  return cuaToolResultError(name, result, structured);
}

function recordToolTiming(name: string, elapsedMs: number): void {
  const rounded = Math.round(elapsedMs * 100) / 100;
  const current = diagnostics.toolTimings[name];
  if (!current) {
    diagnostics.toolTimings[name] = {
      calls: 1,
      totalMs: rounded,
      minMs: rounded,
      maxMs: rounded,
      lastMs: rounded,
    };
    return;
  }
  current.calls += 1;
  current.totalMs = Math.round((current.totalMs + rounded) * 100) / 100;
  current.minMs = Math.min(current.minMs, rounded);
  current.maxMs = Math.max(current.maxMs, rounded);
  current.lastMs = rounded;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  diagnostics.calls += 1;
  const started = performance.now();
  try {
    const connection = await connect();
    const result = await connection.client.callTool({
      name,
      arguments: { ...args, session: SESSION },
    });
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError) throw resultError(name, result, structured);
    if (!structured) throw new Error(`${name} returned no structuredContent`);
    if (structured.status === "refused" || structured.refusal) {
      throw resultError(name, result, structured);
    }
    return structured;
  } catch (error) {
    diagnostics.failures += 1;
    throw error;
  } finally {
    recordToolTiming(name, performance.now() - started);
  }
}

function isBackgroundUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /background[_ -]?unavailable/i.test(text);
}

function recordActionResult(
  tool: string,
  deliveryMode: CuaDriverActionDiagnostic["deliveryMode"],
  result: Record<string, unknown>,
): void {
  const effect = typeof result.effect === "string" ? result.effect : undefined;
  if (effect === "confirmed") diagnostics.confirmedActions += 1;
  else if (effect === "unverifiable") diagnostics.unverifiableActions += 1;
  else if (effect === "suspected_noop") diagnostics.suspectedNoops += 1;

  const escalationRow =
    result.escalation && typeof result.escalation === "object"
      ? (result.escalation as Record<string, unknown>)
      : undefined;
  const escalation =
    (typeof escalationRow?.recommended === "string" && escalationRow.recommended) ||
    (typeof escalationRow?.target === "string" && escalationRow.target) ||
    undefined;
  diagnostics.recentActions.push({
    tool,
    ...(deliveryMode ? { deliveryMode } : {}),
    ...(effect ? { effect } : {}),
    ...(typeof result.route === "string" ? { route: result.route } : {}),
    ...(typeof result.verified === "boolean" ? { verified: result.verified } : {}),
    ...(escalation ? { escalation } : {}),
  });
  if (diagnostics.recentActions.length > 20) diagnostics.recentActions.shift();
}

async function callActionBackgroundFirst(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  diagnostics.backgroundAttempts += 1;
  try {
    const result = await callTool(name, { ...args, delivery_mode: "background" });
    recordActionResult(name, "background", result);
    return result;
  } catch (error) {
    if (!isBackgroundUnavailable(error)) throw error;
    diagnostics.foregroundEscalations += 1;
    const result = await callTool(name, { ...args, delivery_mode: "foreground" });
    recordActionResult(name, "foreground", result);
    return result;
  }
}

function appKey(appName: string): string {
  return appName.trim().replace(/\.exe$/i, "").toLowerCase();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function rawBounds(value: unknown): ResolvedWindow["bounds"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const x = finiteNumber(row.x);
  const y = finiteNumber(row.y);
  const width = finiteNumber(row.width);
  const height = finiteNumber(row.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return undefined;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function normalizeRawWindow(row: RawWindow): ResolvedWindow | undefined {
  const pid = positiveInt(row.pid);
  const windowId = positiveInt(row.window_id);
  const name = row.app_name?.trim();
  const title = row.title?.trim() || "";
  const bounds = rawBounds(row.bounds);
  if (!pid || !windowId || !name || !bounds) return undefined;
  const z = finiteNumber(row.z_index);
  return {
    pid,
    windowId,
    appName: name,
    title,
    bounds,
    ...(z !== undefined ? { zIndex: z } : {}),
    onScreen: row.is_on_screen !== false,
    minimized: row.minimized === true,
  };
}

function sortTargetWindows(rows: ResolvedWindow[]): ResolvedWindow[] {
  return [...rows].sort((left, right) => {
    if (left.onScreen !== right.onScreen) return left.onScreen ? -1 : 1;
    const lz = left.zIndex ?? Number.NEGATIVE_INFINITY;
    const rz = right.zIndex ?? Number.NEGATIVE_INFINITY;
    if (lz !== rz) return rz - lz;
    const la = left.bounds.width * left.bounds.height;
    const ra = right.bounds.width * right.bounds.height;
    return ra - la;
  });
}

function rememberWindowTargets(rows: ResolvedWindow[]): void {
  const grouped = new Map<string, ResolvedWindow[]>();
  for (const row of rows) {
    const key = appKey(row.appName);
    const group = grouped.get(key);
    if (group) group.push(row);
    else grouped.set(key, [row]);
  }
  const now = Date.now();
  for (const [key, group] of grouped) {
    const target = sortTargetWindows(group)[0];
    if (target) targetCache.set(key, { target, storedAt: now });
  }
}

async function rawWindows(): Promise<ResolvedWindow[]> {
  const result = await callTool("list_windows", { on_screen_only: false });
  const rows = Array.isArray(result.windows) ? (result.windows as RawWindow[]) : [];
  const windows = rows.map(normalizeRawWindow).filter((row): row is ResolvedWindow => row !== undefined);
  rememberWindowTargets(windows);
  return windows;
}

function cachedTarget(appName: string): ResolvedWindow | undefined {
  const key = appKey(appName);
  const cached = targetCache.get(key);
  if (cached && Date.now() - cached.storedAt <= TARGET_CACHE_MS) {
    diagnostics.targetCacheHits += 1;
    return cached.target;
  }
  if (cached) targetCache.delete(key);
  diagnostics.targetCacheMisses += 1;
  return undefined;
}

async function resolveTargetWindow(appName: string): Promise<ResolvedWindow> {
  const started = performance.now();
  try {
    const key = appKey(appName);
    const matches = (await rawWindows()).filter((window) => appKey(window.appName) === key);
    const target = sortTargetWindows(matches)[0];
    if (!target) throw new Error(`Cua Driver could not resolve a window for app: ${appName}`);
    targetCache.set(key, { target, storedAt: Date.now() });
    return target;
  } finally {
    diagnostics.targetResolutions += 1;
    diagnostics.targetResolveTotalMs =
      Math.round((diagnostics.targetResolveTotalMs + (performance.now() - started)) * 100) / 100;
  }
}

async function resolveReadTarget(appName: string): Promise<{ target: ResolvedWindow; fromCache: boolean }> {
  const cached = cachedTarget(appName);
  if (cached) return { target: cached, fromCache: true };
  return { target: await resolveTargetWindow(appName), fromCache: false };
}

async function callWindowStateReadOnly(
  appName: string,
  args: (target: ResolvedWindow) => Record<string, unknown>,
): Promise<{ target: ResolvedWindow; data: Record<string, unknown> }> {
  let resolved = await resolveReadTarget(appName);
  try {
    return { target: resolved.target, data: await callTool("get_window_state", args(resolved.target)) };
  } catch (error) {
    if (!resolved.fromCache) throw error;
    // Read-only retry only: a stale short-lived target cache must not make
    // capture fail, but destructive actions are never replayed this way.
    targetCache.delete(appKey(appName));
    resolved = { target: await resolveTargetWindow(appName), fromCache: false };
    return { target: resolved.target, data: await callTool("get_window_state", args(resolved.target)) };
  }
}

function encodeElementRef(ref: CuaElementRef): string {
  return CUAREF_PREFIX + Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

function decodeElementRef(target: { label?: string }): CuaElementRef {
  const label = target.label;
  if (!label?.startsWith(CUAREF_PREFIX)) throw new Error("Cua semantic target is missing its observation-scoped reference");
  try {
    const parsed = JSON.parse(Buffer.from(label.slice(CUAREF_PREFIX.length), "base64url").toString("utf8")) as CuaElementRef;
    if (
      parsed.version !== 1 ||
      !positiveInt(parsed.pid) ||
      !positiveInt(parsed.windowId) ||
      typeof parsed.snapshotId !== "string" ||
      !parsed.snapshotId ||
      typeof parsed.role !== "string" ||
      !parsed.role
    ) {
      throw new Error("invalid Cua semantic reference");
    }
    if (!parsed.elementToken && !nonNegativeInt(parsed.elementIndex)) {
      throw new Error("Cua semantic reference has no element handle");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid Cua semantic reference: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function elementActions(raw: Record<string, unknown>): Array<"invoke" | "setValue" | "focus" | "select"> {
  const source = Array.isArray(raw.actions) ? raw.actions.map((item) => String(item).toLowerCase()) : [];
  const result: Array<"invoke" | "setValue" | "focus" | "select"> = [];
  if (source.some((value) => value.includes("invoke") || value === "press" || value === "click")) result.push("invoke");
  if (source.some((value) => value.includes("setvalue") || value.includes("set_value") || value === "value")) result.push("setValue");
  if (source.some((value) => value.includes("focus"))) result.push("focus");
  if (source.some((value) => value.includes("select"))) result.push("select");
  return result;
}

function elementBounds(raw: Record<string, unknown>): WindowsUiaElement["bounds"] {
  const frame = raw.frame;
  if (!frame || typeof frame !== "object") return undefined;
  const row = frame as Record<string, unknown>;
  const x = finiteNumber(row.x);
  const y = finiteNumber(row.y);
  const width = finiteNumber(row.width) ?? finiteNumber(row.w);
  const height = finiteNumber(row.height) ?? finiteNumber(row.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return undefined;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function normalizeObservation(
  appName: string,
  target: ResolvedWindow,
  data: Record<string, unknown>,
): WindowsUiaObservation {
  const normalizeStarted = performance.now();
  const snapshotId = typeof data.snapshot_id === "string" && data.snapshot_id ? data.snapshot_id : undefined;
  if (!snapshotId) throw new Error("Cua Driver get_window_state returned no snapshot_id");
  const rows = Array.isArray(data.elements) ? (data.elements as Record<string, unknown>[]) : [];
  const elements: WindowsUiaElement[] = [];

  for (const [index, raw] of rows.entries()) {
    const role = typeof raw.role === "string" && raw.role.trim() ? raw.role.trim() : "Custom";
    const title =
      (typeof raw.label === "string" && raw.label.trim()) ||
      (typeof raw.name === "string" && raw.name.trim()) ||
      undefined;
    const elementToken = typeof raw.element_token === "string" && raw.element_token ? raw.element_token : undefined;
    const elementIndex = nonNegativeInt(raw.element_index);
    if (!elementToken && elementIndex === undefined) continue;

    const ref: CuaElementRef = {
      version: 1,
      pid: target.pid,
      windowId: target.windowId,
      snapshotId,
      ...(elementToken ? { elementToken } : {}),
      ...(elementIndex !== undefined ? { elementIndex } : {}),
      role,
      ...(title ? { title } : {}),
    };
    const selector: WindowsUiaSelector = {
      role,
      ...(title ? { title } : {}),
      label: encodeElementRef(ref),
    };
    const actions = elementActions(raw);
    elements.push({
      elementId: `cuael_${index + 1}`,
      role,
      ...(title ? { name: title } : {}),
      ...(typeof raw.automation_id === "string" && raw.automation_id ? { automationId: raw.automation_id } : {}),
      ...(typeof raw.class_name === "string" && raw.class_name ? { className: raw.class_name } : {}),
      enabled: raw.enabled !== false,
      focusable: raw.focusable === true || actions.includes("focus") || actions.includes("setValue"),
      focused: raw.focused === true,
      password: raw.password === true || raw.is_password === true,
      ...(elementBounds(raw) ? { bounds: elementBounds(raw) } : {}),
      actions,
      selector,
    });
  }

  const now = Date.now();
  const total = finiteNumber(data.total_element_count);
  const returned = finiteNumber(data.returned_element_count);
  const observation: WindowsUiaObservation = {
    observationId: `cuaobs_${snapshotId}`,
    appName,
    windowTitle: typeof data.window_title === "string" ? data.window_title : target.title,
    createdAt: now,
    expiresAt: now + 120_000,
    truncated:
      data.truncated === true ||
      (total !== undefined && returned !== undefined && returned < total),
    elements,
  };
  diagnostics.observationNormalizations += 1;
  diagnostics.observationNormalizeTotalMs =
    Math.round((diagnostics.observationNormalizeTotalMs + (performance.now() - normalizeStarted)) * 100) / 100;
  return observation;
}

function cacheObservation(
  appName: string,
  target: ResolvedWindow,
  data: Record<string, unknown>,
): WindowsUiaObservation {
  const observation = normalizeObservation(appName, target, data);
  const screenshotScale = finiteNumber(data.screenshot_scale) ?? 1;
  targetCache.set(appKey(appName), { target, storedAt: Date.now() });
  observationCache.set(appKey(appName), {
    appKey: appKey(appName),
    target,
    observation,
    screenshotScale: screenshotScale > 0 ? screenshotScale : 1,
    storedAt: Date.now(),
  });
  return observation;
}

export async function resolveFrontmostApp(): Promise<string | undefined> {
  const windows = (await rawWindows()).filter((window) => window.onScreen && window.zIndex !== undefined);
  if (!windows.length) return undefined;
  return [...windows].sort((left, right) => (right.zIndex ?? 0) - (left.zIndex ?? 0))[0]?.appName;
}

export async function listVisibleWindows(): Promise<VisibleAppWindow[]> {
  const windows = await rawWindows();
  const front = windows
    .filter((window) => window.onScreen && window.zIndex !== undefined)
    .sort((left, right) => (right.zIndex ?? 0) - (left.zIndex ?? 0))[0];

  return windows.slice(0, 200).map((window, index) => ({
    windowId: `cua-window-${index + 1}`,
    processId: window.pid,
    processName: window.appName,
    appName: window.appName,
    title: window.title,
    visible: true as const,
    minimized: window.minimized,
    foreground: front?.pid === window.pid && front?.windowId === window.windowId,
    dpi: DEFAULT_DPI,
    scaleFactor: 1,
    bounds: { ...window.bounds },
  }));
}

export async function captureAppWindow(
  appName: string,
  filePath: string,
  options: { includeAccessibilityTree?: boolean } = {},
): Promise<CuaAppScreenshot> {
  assertWindows();
  if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== ".png") {
    throw new Error("Cua Driver app capture requires an absolute .png output path");
  }
  const includeAccessibilityTree = options.includeAccessibilityTree !== false;
  const { target, data } = await callWindowStateReadOnly(appName, (resolved) => ({
    pid: resolved.pid,
    window_id: resolved.windowId,
    screenshot_out_file: filePath,
    include_accessibility_tree: includeAccessibilityTree,
    include_screenshot: true,
    ...(includeAccessibilityTree ? { max_elements: 120, max_depth: 8 } : {}),
  }));
  // A screenshot-only evidence capture must not replace the semantic snapshot
  // that an already-approved element token is bound to.
  if (includeAccessibilityTree) cacheObservation(appName, target, data);
  const width = positiveInt(data.screenshot_width) ?? target.bounds.width;
  const height = positiveInt(data.screenshot_height) ?? target.bounds.height;
  const scaleFactor = finiteNumber(data.screenshot_scale) ?? 1;
  return {
    path: filePath,
    appName: typeof data.app_name === "string" && data.app_name ? data.app_name : target.appName,
    title: typeof data.window_title === "string" ? data.window_title : target.title,
    width,
    height,
    dpi: DEFAULT_DPI,
    scaleFactor: scaleFactor > 0 ? scaleFactor : 1,
    captureMethod: "cua-driver",
  };
}

export async function snapshotSemanticElements(
  appName: string,
  options: { maxElements?: number; maxDepth?: number } = {},
): Promise<WindowsUiaObservation> {
  const cached = observationCache.get(appKey(appName));
  if (cached && Date.now() - cached.storedAt <= OBSERVATION_CACHE_MS) {
    diagnostics.observationCacheHits += 1;
    return cached.observation;
  }

  const maxElements = Math.min(120, Math.max(1, options.maxElements ?? 120));
  const maxDepth = Math.min(10, Math.max(1, options.maxDepth ?? 8));
  const { target, data } = await callWindowStateReadOnly(appName, (resolved) => ({
    pid: resolved.pid,
    window_id: resolved.windowId,
    include_accessibility_tree: true,
    include_screenshot: false,
    max_elements: maxElements,
    max_depth: maxDepth,
  }));
  return cacheObservation(appName, target, data);
}

export async function getAppWindowRegion(appName: string): Promise<ResolvedWindow["bounds"]> {
  return { ...(await resolveTargetWindow(appName)).bounds };
}

export async function resolveWindowPoint(appName: string, xRel: number, yRel: number): Promise<{ x: number; y: number }> {
  const region = await getAppWindowRegion(appName);
  return {
    x: Math.round(region.x + region.width * xRel),
    y: Math.round(region.y + region.height * yRel),
  };
}

export async function clickAtPoint(appName: string, x: number, y: number): Promise<void> {
  const target = await resolveTargetWindow(appName);
  const cached = observationCache.get(appKey(appName));
  const scale =
    cached &&
    cached.target.pid === target.pid &&
    cached.target.windowId === target.windowId
      ? cached.screenshotScale
      : 1;
  const localX = (x - target.bounds.x) * scale;
  const localY = (y - target.bounds.y) * scale;
  await callActionBackgroundFirst("click", {
    pid: target.pid,
    window_id: target.windowId,
    x: Math.round(localX),
    y: Math.round(localY),
  });
}

export async function typeText(appName: string, text: string): Promise<void> {
  const target = await resolveTargetWindow(appName);
  await callActionBackgroundFirst("type_text", {
    pid: target.pid,
    window_id: target.windowId,
    text,
  });
}

function cuaKeyNameFromLegacyKeyCode(keyCode: number): string | undefined {
  const direct: Readonly<Record<number, string>> = {
    36: "return",
    48: "tab",
    49: "space",
    51: "delete",
    53: "escape",
    114: "home",
    115: "home",
    116: "pageup",
    117: "delete",
    119: "end",
    121: "pagedown",
    123: "left",
    124: "right",
    125: "down",
    126: "up",
    122: "f1",
    120: "f2",
    99: "f3",
    118: "f4",
    96: "f5",
    97: "f6",
    98: "f7",
    100: "f8",
    101: "f9",
    109: "f10",
    103: "f11",
    111: "f12",
  };
  if (direct[keyCode]) return direct[keyCode];

  const letters: Readonly<Record<number, string>> = {
    0:"a",1:"s",2:"d",3:"f",4:"h",5:"g",6:"z",7:"x",8:"c",9:"v",11:"b",
    12:"q",13:"w",14:"e",15:"r",16:"y",17:"t",31:"o",32:"u",34:"i",35:"p",
    37:"l",38:"j",40:"k",45:"n",46:"m",
  };
  if (letters[keyCode]) return letters[keyCode];
  const digits: Readonly<Record<number, string>> = {
    18:"1",19:"2",20:"3",21:"4",23:"5",22:"6",26:"7",28:"8",25:"9",29:"0",
  };
  return digits[keyCode];
}

export async function pressKey(appName: string, keyCode: number): Promise<void> {
  const key = cuaKeyNameFromLegacyKeyCode(keyCode);
  if (!key) throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Legacy keyCode ${keyCode} is not mapped for Cua Driver yet`);
  const target = await resolveTargetWindow(appName);
  await callActionBackgroundFirst("press_key", {
    pid: target.pid,
    window_id: target.windowId,
    key,
  });
}

function refActionArgs(ref: CuaElementRef): Record<string, unknown> {
  return {
    pid: ref.pid,
    window_id: ref.windowId,
    snapshot_id: ref.snapshotId,
    ...(ref.elementToken ? { element_token: ref.elementToken } : { element_index: ref.elementIndex }),
  };
}

function validateRefWindow(
  appName: string,
  target: { label?: string },
  ref: CuaElementRef,
): CachedObservation {
  const cached = observationCache.get(appKey(appName));
  if (!cached || Date.now() > cached.observation.expiresAt) {
    throw new Error("Cua semantic target has no live observation cache");
  }
  if (
    cached.target.pid !== ref.pid ||
    cached.target.windowId !== ref.windowId ||
    cached.observation.observationId !== `cuaobs_${ref.snapshotId}`
  ) {
    throw new Error("Cua semantic target is stale or belongs to a different window/snapshot");
  }
  if (!target.label || !cached.observation.elements.some((row) => row.selector.label === target.label)) {
    throw new Error("Cua semantic target is not present in the current observation cache");
  }
  return cached;
}

export async function resolveSemanticElement(
  appName: string,
  target: { role: string; title?: string; label?: string; description?: string },
): Promise<ResolvedTargetPreview> {
  let ref: CuaElementRef;
  try {
    ref = decodeElementRef(target);
  } catch (error) {
    return { found: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    validateRefWindow(appName, target, ref);
  } catch (error) {
    return { found: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const cached = observationCache.get(appKey(appName));
  const element = cached?.observation.elements.find((row) => row.selector.label === target.label);
  if (!element) return { found: false, reason: "Cua semantic target is no longer in the current observation cache" };
  return {
    found: true,
    role: element.role,
    title: element.name,
    frame: element.bounds,
    app: appName,
    window: cached?.observation.windowTitle,
    matchCount: 1,
    actions: [...element.actions],
  };
}

export async function pressSemanticElement(appName: string, target: { label?: string }): Promise<void> {
  const ref = decodeElementRef(target);
  validateRefWindow(appName, target, ref);
  await callActionBackgroundFirst("click", refActionArgs(ref));
}

export async function setSemanticValue(appName: string, target: { label?: string }, text: string): Promise<void> {
  const ref = decodeElementRef(target);
  validateRefWindow(appName, target, ref);
  // Match the legacy backend's ValuePattern.SetValue semantics exactly.
  // type_text is cursor-oriented text entry and may append to an existing
  // value; set_value replaces the whole UIA ValuePattern value.
  const result = await callTool("set_value", {
    ...refActionArgs(ref),
    value: text,
  });
  recordActionResult("set_value", "semantic", result);
}

export interface CuaExactWindowTarget {
  pid: number;
  windowId: number;
  appName: string;
  title: string;
  minimized: boolean;
  onScreen: boolean;
}

export async function resolveCuaExactWindowTarget(
  titleIncludes: string,
  timeoutMs = 15_000,
  options: { allowMinimized?: boolean } = {},
): Promise<CuaExactWindowTarget> {
  assertWindows();
  const needle = titleIncludes.trim().toLowerCase();
  if (!needle) throw new Error("Exact-window target resolution requires a non-empty title fragment");

  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    const windows = await rawWindows();
    const target = windows.find(
      (window) =>
        (options.allowMinimized || (window.onScreen && !window.minimized)) &&
        window.title.toLowerCase().includes(needle),
    );
    if (target) {
      return {
        pid: target.pid,
        windowId: target.windowId,
        appName: target.appName,
        title: target.title,
        minimized: target.minimized,
        onScreen: target.onScreen,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Cua Driver could not find a window containing title: ${titleIncludes}`);
}

export async function probeCuaExplicitWindowObservation(
  target: { pid: number; windowId: number },
  outputPath: string,
): Promise<{
  elapsedMs: number;
  snapshotId?: string;
  windowTitle?: string;
  appName?: string;
  elementCount: number;
}> {
  assertWindows();
  const started = performance.now();
  const data = await callTool("get_window_state", {
    pid: target.pid,
    window_id: target.windowId,
    include_accessibility_tree: true,
    include_screenshot: true,
    screenshot_out_file: outputPath,
    max_elements: 120,
    max_depth: 8,
  });
  return {
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    ...(typeof data.snapshot_id === "string" ? { snapshotId: data.snapshot_id } : {}),
    ...(typeof data.window_title === "string" ? { windowTitle: data.window_title } : {}),
    ...(typeof data.app_name === "string" ? { appName: data.app_name } : {}),
    elementCount: Array.isArray(data.elements) ? data.elements.length : 0,
  };
}
export interface CuaExactWindowObservationProbe {
  target: {
    pid: number;
    windowId: number;
    appName: string;
    title: string;
  };
  samples: Array<{
    elapsedMs: number;
    elementCount: number;
    screenshotPath: string;
  }>;
}

export async function probeCuaExactWindowObservations(
  titleIncludes: string,
  outputDir: string,
  iterations: number,
  timeoutMs = 15_000,
): Promise<CuaExactWindowObservationProbe> {
  assertWindows();
  const needle = titleIncludes.trim().toLowerCase();
  if (!needle) throw new Error("Exact-window observation probe requires a non-empty title fragment");

  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let target: ResolvedWindow | undefined;
  while (Date.now() < deadline) {
    const windows = await rawWindows();
    target = windows.find(
      (window) =>
        window.onScreen &&
        !window.minimized &&
        window.title.toLowerCase().includes(needle),
    );
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!target) throw new Error(`Cua Driver could not find a visible window containing title: ${titleIncludes}`);

  const count = Math.max(1, Math.min(20, Math.trunc(iterations)));
  const samples: CuaExactWindowObservationProbe["samples"] = [];
  for (let index = 0; index < count; index += 1) {
    const screenshotPath = path.join(
      outputDir,
      `cua-exact-window-${target.pid}-${target.windowId}-${index + 1}.png`,
    );
    const started = performance.now();
    const data = await callTool("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: true,
      include_screenshot: true,
      screenshot_out_file: screenshotPath,
      max_elements: 120,
      max_depth: 8,
    });
    const elapsedMs = performance.now() - started;
    const rows = Array.isArray(data.elements) ? data.elements.length : 0;
    if (typeof data.snapshot_id !== "string" || !data.snapshot_id) {
      throw new Error(`Cua Driver returned no snapshot_id for exact window ${target.windowId}`);
    }
    samples.push({
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      elementCount: rows,
      screenshotPath,
    });
  }

  return {
    target: {
      pid: target.pid,
      windowId: target.windowId,
      appName: target.appName,
      title: target.title,
    },
    samples,
  };
}
export interface CuaObservationModeProbeSample {
  combinedMs: number;
  treeOnlyMs: number;
  screenshotOnlyMs: number;
  parallelMs: number;
  treeElements: number;
}

export async function probeCuaObservationModes(
  appName: string,
  outputDir: string,
  iterations: number,
): Promise<CuaObservationModeProbeSample[]> {
  assertWindows();
  const count = Math.max(1, Math.min(20, Math.trunc(iterations)));
  const samples: CuaObservationModeProbeSample[] = [];
  for (let index = 0; index < count; index += 1) {
    const target = (await resolveReadTarget(appName)).target;
    const base = path.join(outputDir, `cua-observe-probe-${index + 1}`);

    const combinedStarted = performance.now();
    await callTool("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: true,
      include_screenshot: true,
      screenshot_out_file: `${base}-combined.png`,
      max_elements: 120,
      max_depth: 8,
    });
    const combinedMs = performance.now() - combinedStarted;

    const treeStarted = performance.now();
    const tree = await callTool("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: true,
      include_screenshot: false,
      max_elements: 120,
      max_depth: 8,
    });
    const treeOnlyMs = performance.now() - treeStarted;

    const screenshotStarted = performance.now();
    await callTool("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: false,
      include_screenshot: true,
      screenshot_out_file: `${base}-screenshot.png`,
    });
    const screenshotOnlyMs = performance.now() - screenshotStarted;

    const parallelStarted = performance.now();
    const [parallelTree] = await Promise.all([
      callTool("get_window_state", {
        pid: target.pid,
        window_id: target.windowId,
        include_accessibility_tree: true,
        include_screenshot: false,
        max_elements: 120,
        max_depth: 8,
      }),
      callTool("get_window_state", {
        pid: target.pid,
        window_id: target.windowId,
        include_accessibility_tree: false,
        include_screenshot: true,
        screenshot_out_file: `${base}-parallel.png`,
      }),
    ]);
    const parallelMs = performance.now() - parallelStarted;

    const rows = Array.isArray(tree.elements) ? tree.elements.length : 0;
    const parallelRows = Array.isArray(parallelTree.elements) ? parallelTree.elements.length : 0;
    samples.push({
      combinedMs: Math.round(combinedMs * 100) / 100,
      treeOnlyMs: Math.round(treeOnlyMs * 100) / 100,
      screenshotOnlyMs: Math.round(screenshotOnlyMs * 100) / 100,
      parallelMs: Math.round(parallelMs * 100) / 100,
      treeElements: Math.max(rows, parallelRows),
    });
  }
  return samples;
}

export async function setCuaCursorOverlayEnabled(enabled: boolean): Promise<void> {
  await callTool("set_agent_cursor_enabled", { enabled });
}

export function getCuaDriverDiagnostics(): CuaDriverDiagnostics {
  return {
    ...diagnostics,
    toolTimings: Object.fromEntries(
      Object.entries(diagnostics.toolTimings).map(([name, timing]) => [name, { ...timing }]),
    ),
    recentActions: diagnostics.recentActions.map((row) => ({ ...row })),
  };
}

export function resetCuaDriverDiagnostics(): void {
  diagnostics.calls = 0;
  diagnostics.backgroundAttempts = 0;
  diagnostics.foregroundEscalations = 0;
  diagnostics.failures = 0;
  diagnostics.confirmedActions = 0;
  diagnostics.unverifiableActions = 0;
  diagnostics.suspectedNoops = 0;
  diagnostics.observationCacheHits = 0;
  diagnostics.observationNormalizations = 0;
  diagnostics.observationNormalizeTotalMs = 0;
  diagnostics.targetResolutions = 0;
  diagnostics.targetResolveTotalMs = 0;
  diagnostics.targetCacheHits = 0;
  diagnostics.targetCacheMisses = 0;
  diagnostics.toolTimings = {};
  diagnostics.recentActions = [];
}

export async function stopCuaDriver(): Promise<void> {
  const pending = connectionPromise;
  connectionPromise = undefined;
  observationCache.clear();
  targetCache.clear();
  if (!pending) return;
  try {
    const connection = await pending;
    await connection.client.close();
  } catch {
    // Best-effort shutdown only.
  }
}
