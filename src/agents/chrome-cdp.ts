import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DomainError, ErrorCode } from "../types.js";
import { applyWorkerExecutionIntent } from "./chrome-execution.js";
import type {
  BrowserWorkerDriver,
  BrowserWorkerLaunchInput,
  BrowserWorkerLaunchResult,
} from "./browser-controller.js";

const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_WORKER_APP_NAME = "ChatGPT To Codex Worker";
const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_COMPOSER_ATTEMPTS = 40;
const DEFAULT_COMPOSER_POLL_MS = 250;
const DEFAULT_APP_MENTION_ATTEMPTS = 20;
const DEFAULT_APP_MENTION_POLL_MS = 100;

export interface ChromeDevToolsEndpoint {
  port: number;
  browserWebSocketPath?: string;
}

export interface ChromePageTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface ChromeCdpDriverDeps {
  ensureEndpoint: () => Promise<ChromeDevToolsEndpoint>;
  openTarget: (endpoint: ChromeDevToolsEndpoint, url: string) => Promise<ChromePageTarget>;
  closeTarget: (endpoint: ChromeDevToolsEndpoint, targetId: string) => Promise<void>;
  connect: (webSocketDebuggerUrl: string) => Promise<CdpConnection>;
  sleepMs?: (ms: number) => Promise<void>;
  composerAttempts?: number;
  composerPollMs?: number;
  workerAppName?: string;
  appMentionAttempts?: number;
  appMentionPollMs?: number;
}

export interface ChromeEndpointManagerOptions {
  chromeExecutable?: string;
  profileDir?: string;
  startTimeoutMs?: number;
}

interface CdpEvaluateResult {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: unknown;
}

function resultValue(value: unknown): unknown {
  return (value as CdpEvaluateResult | undefined)?.result?.value;
}

function pageReadyExpression(): string {
  return `(() => {
    const composer = document.querySelector('#prompt-textarea');
    if (!composer) return false;
    const rect = composer.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`;
}

function focusComposerExpression(): string {
  return `(() => {
    const composer = document.querySelector('#prompt-textarea');
    if (!(composer instanceof HTMLElement)) return false;
    composer.focus();
    return true;
  })()`;
}

function focusComposerEndExpression(): string {
  return `(() => {
    const composer = document.querySelector('#prompt-textarea');
    if (!(composer instanceof HTMLElement)) return false;
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const end = composer.value.length;
      composer.setSelectionRange(end, end);
      return true;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  })()`;
}

function appSuggestionExpression(appName: string): string {
  const encoded = JSON.stringify(appName);
  return `(() => {
    const expected = ${encoded};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const expectedText = normalize(expected);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const roots = Array.from(document.querySelectorAll(
      '[role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-floating-ui-portal]'
    )).filter(visible);
    const selector = '[role="option"], [role="menuitem"], [role="menuitemradio"], [data-radix-collection-item], button';
    const standardCandidates = roots
      .flatMap((root) => Array.from(root.querySelectorAll(selector)))
      .filter(visible);

    // Current ChatGPT @ app picker is a role-less .popover whose clickable
    // rows are role-less .__menu-item elements. Keep this bounded to those
    // visible rows rather than scanning/clicking arbitrary page text.
    const popoverCandidates = Array.from(document.querySelectorAll('.popover .__menu-item')).filter(visible);
    const candidates = Array.from(new Set([...standardCandidates, ...popoverCandidates]));
    const hasExactLabel = (element) => {
      const labels = [
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        ...Array.from(element.querySelectorAll('*')).flatMap((child) => [
          child.textContent,
          child.getAttribute('aria-label'),
          child.getAttribute('title'),
        ]),
      ];
      return labels.some((label) => normalize(label) === expectedText);
    };
    const exactMatches = candidates.filter(hasExactLabel);
    const prefixMatches = exactMatches.length === 0
      ? candidates.filter((element) => normalize(element.textContent).startsWith(expectedText + ' '))
      : [];
    const candidate = exactMatches.length === 1
      ? exactMatches[0]
      : (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
    if (!(candidate instanceof HTMLElement)) return { ok: false };
    candidate.click();
    return { ok: true, text: String(candidate.textContent || '').trim() };
  })()`;
}

function selectedWorkerAppExpression(appName: string): string {
  const encoded = JSON.stringify(appName);
  return `(() => {
    const composer = document.querySelector('#prompt-textarea');
    if (!(composer instanceof HTMLElement)) return false;
    const expectedText = String(${encoded}).replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    // ChatGPT currently materializes a selected @ app as an inline anchor
    // inside the ProseMirror composer. Plain typed mention text is not an
    // anchor, so this distinguishes a real app selection from an unselected
    // "@ChatGPT To Codex Worker" query.
    const inlineSelectedApp = Array.from(composer.querySelectorAll('a')).some((element) =>
      visible(element) && normalize(element.textContent) === expectedText
    );
    if (inlineSelectedApp) return true;

    // Keep the outside-composer fallback for older/alternate ChatGPT layouts
    // where the selected app may render as a sibling chip or toolbar control.
    const suggestionRootSelector = '[role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-floating-ui-portal]';
    let scope = composer.closest('form');
    if (!(scope instanceof HTMLElement)) {
      scope = composer.parentElement;
      for (let depth = 0; depth < 4 && scope?.parentElement; depth += 1) {
        scope = scope.parentElement;
      }
    }
    if (!(scope instanceof HTMLElement)) return false;
    const elements = Array.from(scope.querySelectorAll('*')).filter(visible);
    return elements.some((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element === composer || composer.contains(element)) return false;
      if (element.closest(suggestionRootSelector)) return false;
      const labels = [
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ];
      return labels.some((label) => normalize(label) === expectedText);
    });
  })()`;
}

function clearTypedAppQueryExpression(appName: string): string {
  const encoded = JSON.stringify(`@${appName}`);
  return `(() => {
    const composer = document.querySelector('#prompt-textarea');
    if (!(composer instanceof HTMLElement)) return false;
    const expected = ${encoded};
    const current = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value
      : (composer.textContent || '');
    if (current.trim() !== expected) return false;
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      composer.value = '';
    } else {
      composer.textContent = '';
    }
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
      data: null,
    }));
    composer.focus();
    return true;
  })()`;
}

function submittedExpression(): string {
  return `(() => {
    const composer = document.querySelector('#prompt-textarea');
    if (!composer) return true;
    const current = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value
      : (composer.textContent || '');
    return current.trim().length === 0;
  })()`;
}

function normalizeWorkerAppName(value: string | undefined): string {
  const normalized = (value ?? DEFAULT_WORKER_APP_NAME).trim().replace(/^@+/, '').trim();
  if (!normalized || normalized.length > 120 || /[\r\n]/u.test(normalized)) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      "CHATGPT2CODEX_WORKER_APP_NAME must be a single non-empty ChatGPT app name (120 characters max)",
    );
  }
  return normalized;
}

export function buildWorkerBootstrap(input: BrowserWorkerLaunchInput): string {
  return [
    "You are an isolated coding worker launched by chatgpt2codex.",
    "Complete the assigned coding task directly. Do not only review or describe the solution.",
    "The dedicated ChatGPT To Codex Worker app is attached to this message. Use only its worker_* repository tools.",
    "Do not call project_select, normal non-worker file/shell/git tools, Computer Use, Agent Manager, Skills, or plugin proxies.",
    `Worker capability: ${input.workerToken}`,
    "Pass that capability as workerToken on every worker_* tool call. It is scoped to your isolated worktree and becomes invalid when the worker ends.",
    "Start with worker_project_rules and narrow inspection. Modify files in the worker worktree, run focused checks, and commit the completed change when appropriate.",
    "When the task is finished, call worker_finish with workerToken, a concise summary, changed files, checks, commit SHA if committed, and any remaining issues.",
    "Do not wait for the parent chat and do not ask it to perform your assigned work.",
    "",
    "Assigned task:",
    input.task.trim(),
  ].join("\n");
}

async function waitForComposer(
  connection: CdpConnection,
  attempts: number,
  pollMs: number,
  sleepMs: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: pageReadyExpression(),
      returnByValue: true,
    });
    if (resultValue(evaluated) === true) return true;
    await sleepMs(pollMs);
  }
  return false;
}

async function workerAppIsSelected(connection: CdpConnection, appName: string): Promise<boolean> {
  const evaluated = await connection.send("Runtime.evaluate", {
    expression: selectedWorkerAppExpression(appName),
    returnByValue: true,
  });
  return resultValue(evaluated) === true;
}

async function clearTypedAppQuery(connection: CdpConnection, appName: string): Promise<boolean> {
  const evaluated = await connection.send("Runtime.evaluate", {
    expression: clearTypedAppQueryExpression(appName),
    returnByValue: true,
  }).catch(() => undefined);
  return resultValue(evaluated) === true;
}

async function selectWorkerApp(
  connection: CdpConnection,
  appName: string,
  attempts: number,
  pollMs: number,
  sleepMs: (ms: number) => Promise<void>,
): Promise<void> {
  const focused = await connection.send("Runtime.evaluate", {
    expression: focusComposerExpression(),
    returnByValue: true,
  });
  if (resultValue(focused) !== true) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "ChatGPT worker composer could not be focused");
  }

  if (await workerAppIsSelected(connection, appName)) {
    await clearTypedAppQuery(connection, appName);
    return;
  }

  // A failed/abandoned launch can leave the exact plain-text @ app query as a
  // restored ChatGPT draft. Clear only that exact worker-app query before
  // inserting a fresh one; never erase arbitrary user draft content.
  await clearTypedAppQuery(connection, appName);

  await connection.send("Input.insertText", { text: `@${appName}` });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await workerAppIsSelected(connection, appName)) {
      await clearTypedAppQuery(connection, appName);
      return;
    }

    const selected = await connection.send("Runtime.evaluate", {
      expression: appSuggestionExpression(appName),
      returnByValue: true,
    });
    const selectedValue = resultValue(selected) as { ok?: boolean } | undefined;
    if (selectedValue?.ok === true) {
      await sleepMs(50);
      if (await workerAppIsSelected(connection, appName)) {
        await clearTypedAppQuery(connection, appName);
        return;
      }
    }

    await sleepMs(pollMs);
    if (await workerAppIsSelected(connection, appName)) {
      await clearTypedAppQuery(connection, appName);
      return;
    }
  }

  throw new DomainError(
    ErrorCode.WORKSPACE_NOT_READY,
    `ChatGPT worker app "${appName}" was not available in the @ mention menu. Create/connect a custom app with that name pointing to /mcp/worker, or set CHATGPT2CODEX_WORKER_APP_NAME to the installed worker app name.`,
  );
}

async function submitWorkerPrompt(
  connection: CdpConnection,
  appName: string,
  prompt: string,
  appMentionAttempts: number,
  appMentionPollMs: number,
  sleepMs: (ms: number) => Promise<void>,
): Promise<void> {
  await selectWorkerApp(connection, appName, appMentionAttempts, appMentionPollMs, sleepMs);

  const focused = await connection.send("Runtime.evaluate", {
    expression: focusComposerEndExpression(),
    returnByValue: true,
  });
  if (resultValue(focused) !== true) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "ChatGPT worker composer lost focus after app selection");
  }
  await connection.send("Input.insertText", { text: `\n${prompt}` });

  await connection.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await connection.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function promptWasSubmitted(connection: CdpConnection): Promise<boolean> {
  const evaluated = await connection.send("Runtime.evaluate", {
    expression: submittedExpression(),
    returnByValue: true,
  });
  return resultValue(evaluated) === true;
}

/**
 * Minimal ChatGPT worker driver over Chrome DevTools Protocol. It never tracks
 * ChatGPT private conversation/request ids: the CDP target id is only a local
 * browser handle used for cancellation/recovery. Before the bootstrap is sent,
 * the driver explicitly selects the dedicated worker MCP app through ChatGPT's
 * @ mention UI so that the message receives the /mcp/worker tool catalog rather
 * than relying on prompt text to avoid the main-agent app.
 */
export class ChromeCdpBrowserWorkerDriver implements BrowserWorkerDriver {
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly composerAttempts: number;
  private readonly composerPollMs: number;
  private readonly workerAppName: string | undefined;
  private readonly appMentionAttempts: number;
  private readonly appMentionPollMs: number;

  constructor(private readonly deps: ChromeCdpDriverDeps) {
    this.sleepMs = deps.sleepMs ?? ((ms) => delay(ms));
    this.composerAttempts = Math.max(1, deps.composerAttempts ?? DEFAULT_COMPOSER_ATTEMPTS);
    this.composerPollMs = Math.max(0, deps.composerPollMs ?? DEFAULT_COMPOSER_POLL_MS);
    this.workerAppName = deps.workerAppName;
    this.appMentionAttempts = Math.max(1, deps.appMentionAttempts ?? DEFAULT_APP_MENTION_ATTEMPTS);
    this.appMentionPollMs = Math.max(0, deps.appMentionPollMs ?? DEFAULT_APP_MENTION_POLL_MS);
  }

  async launch(input: BrowserWorkerLaunchInput): Promise<BrowserWorkerLaunchResult> {
    const endpoint = await this.deps.ensureEndpoint();
    const preferredUrl = input.route.mode === "project" ? input.route.projectRef.url : DEFAULT_CHATGPT_URL;
    const prompt = buildWorkerBootstrap(input);
    const workerAppName = normalizeWorkerAppName(this.workerAppName);

    let target = await this.deps.openTarget(endpoint, preferredUrl);
    let connection = await this.deps.connect(target.webSocketDebuggerUrl);
    let fallbackUsed = false;

    try {
      await connection.send("Runtime.enable");
      let ready = await waitForComposer(
        connection,
        this.composerAttempts,
        this.composerPollMs,
        this.sleepMs,
      );

      if (!ready && input.route.mode === "project") {
        connection.close();
        await this.deps.closeTarget(endpoint, target.id).catch(() => undefined);
        target = await this.deps.openTarget(endpoint, DEFAULT_CHATGPT_URL);
        connection = await this.deps.connect(target.webSocketDebuggerUrl);
        await connection.send("Runtime.enable");
        ready = await waitForComposer(
          connection,
          this.composerAttempts,
          this.composerPollMs,
          this.sleepMs,
        );
        fallbackUsed = true;
      }

      if (!ready) {
        throw new DomainError(
          ErrorCode.WORKSPACE_NOT_READY,
          "ChatGPT worker browser is open but no composer is available. Sign in to ChatGPT in the dedicated worker Chrome profile, then retry.",
        );
      }

      // Durable execution intent is applied and post-verified before the Worker
      // app is selected or any bootstrap text is inserted into the composer.
      await applyWorkerExecutionIntent(connection, input.executionIntent, this.sleepMs);

      await submitWorkerPrompt(
        connection,
        workerAppName,
        prompt,
        this.appMentionAttempts,
        this.appMentionPollMs,
        this.sleepMs,
      );
      await this.sleepMs(150);
      if (!(await promptWasSubmitted(connection))) {
        throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "ChatGPT worker bootstrap was not submitted");
      }

      return {
        browserHandle: `cdp:${target.id}`,
        ...(fallbackUsed ? { fallbackUsed: true } : {}),
      } as BrowserWorkerLaunchResult;
    } catch (error) {
      await this.deps.closeTarget(endpoint, target.id).catch(() => undefined);
      throw error;
    } finally {
      connection.close();
    }
  }

  async cancel(input: { workerId: string; browserHandle?: string }): Promise<void> {
    const targetId = input.browserHandle?.startsWith("cdp:") ? input.browserHandle.slice(4) : undefined;
    if (!targetId) return;
    const endpoint = await this.deps.ensureEndpoint();
    await this.deps.closeTarget(endpoint, targetId);
  }
}

function executableCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    return [
      env.CHATGPT2CODEX_WORKER_CHROME,
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    ].filter((value): value is string => Boolean(value));
  }
  if (platform === "darwin") {
    return [
      env.CHATGPT2CODEX_WORKER_CHROME,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ].filter((value): value is string => Boolean(value));
  }
  return [
    env.CHATGPT2CODEX_WORKER_CHROME,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));
}

export async function findChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  for (const candidate of executableCandidates(platform, env)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new DomainError(
    ErrorCode.WORKSPACE_NOT_READY,
    "Google Chrome was not found. Install Chrome or set CHATGPT2CODEX_WORKER_CHROME to its executable path.",
  );
}

async function readActivePort(profileDir: string): Promise<ChromeDevToolsEndpoint | null> {
  try {
    const text = await fs.readFile(path.join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE), "utf8");
    const [portLine, browserWebSocketPath] = text.trim().split(/\r?\n/);
    const port = Number.parseInt(portLine ?? "", 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return { port, browserWebSocketPath: browserWebSocketPath || undefined };
  } catch {
    return null;
  }
}

async function endpointAlive(endpoint: ChromeDevToolsEndpoint): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class ChromeEndpointManager {
  readonly profileDir: string;
  private readonly startTimeoutMs: number;
  private readonly explicitExecutable?: string;

  constructor(
    private readonly stateDir: string,
    options: ChromeEndpointManagerOptions = {},
  ) {
    this.profileDir = options.profileDir ?? path.join(stateDir, "agents", "chrome-worker-profile");
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.explicitExecutable = options.chromeExecutable;
  }

  async ensureEndpoint(): Promise<ChromeDevToolsEndpoint> {
    const existing = await readActivePort(this.profileDir);
    if (existing && (await endpointAlive(existing))) return existing;

    await fs.mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    await fs.rm(path.join(this.profileDir, DEVTOOLS_ACTIVE_PORT_FILE), { force: true }).catch(() => undefined);
    const executable = this.explicitExecutable ?? (await findChromeExecutable());
    const child = spawn(
      executable,
      [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      const endpoint = await readActivePort(this.profileDir);
      if (endpoint && (await endpointAlive(endpoint))) return endpoint;
      await delay(100);
    }
    throw new DomainError(ErrorCode.TIMEOUT, "Timed out starting the dedicated ChatGPT worker Chrome profile");
  }
}

export async function openChromeTarget(endpoint: ChromeDevToolsEndpoint, url: string): Promise<ChromePageTarget> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Chrome failed to open worker tab: HTTP ${response.status}`);
  }
  const target = (await response.json()) as Partial<ChromePageTarget>;
  if (!target.id || !target.webSocketDebuggerUrl) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Chrome returned an invalid DevTools target");
  }
  return {
    id: target.id,
    url: target.url ?? url,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  };
}

export async function closeChromeTarget(endpoint: ChromeDevToolsEndpoint, targetId: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/close/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Chrome failed to close target ${targetId}: HTTP ${response.status}`);
  }
}

class WebSocketCdpConnection implements CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
        else pending.resolve(message.result ?? {});
      } catch {
        // Ignore non-command events or malformed messages; command timeouts
        // still fail safely.
      }
    });
    socket.addEventListener("close", () => this.rejectAll(new Error("Chrome DevTools connection closed")));
    socket.addEventListener("error", () => this.rejectAll(new Error("Chrome DevTools connection failed")));
  }

  static connect(url: string): Promise<WebSocketCdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new DomainError(ErrorCode.TIMEOUT, "Timed out connecting to Chrome DevTools"));
      }, 5_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new WebSocketCdpConnection(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Could not connect to Chrome DevTools target"));
        },
        { once: true },
      );
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DomainError(ErrorCode.TIMEOUT, `Chrome DevTools command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function createChromeCdpBrowserWorkerDriver(
  stateDir: string,
  options: ChromeEndpointManagerOptions = {},
): ChromeCdpBrowserWorkerDriver {
  const endpointManager = new ChromeEndpointManager(stateDir, options);
  return new ChromeCdpBrowserWorkerDriver({
    ensureEndpoint: () => endpointManager.ensureEndpoint(),
    openTarget: openChromeTarget,
    closeTarget: closeChromeTarget,
    connect: (url) => WebSocketCdpConnection.connect(url),
    workerAppName: process.env.CHATGPT2CODEX_WORKER_APP_NAME,
  });
}
