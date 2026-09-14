import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BrowserCompletionObservation,
  BrowserCompletionProbe,
} from "./browser-recovery.js";

const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
const DEFAULT_STABILITY_MS = 250;
const CDP_TIMEOUT_MS = 3_000;

interface ChromeTargetListEntry {
  id?: string;
  type?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  result?: {
    result?: {
      value?: unknown;
    };
  };
  error?: { message?: string };
}

function targetIdFromHandle(handle: string | undefined): string | null {
  if (!handle?.startsWith("cdp:")) return null;
  const targetId = handle.slice("cdp:".length).trim();
  return targetId || null;
}

async function activeDevToolsPort(profileDir: string): Promise<number | null> {
  try {
    const text = await fs.readFile(path.join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE), "utf8");
    const port = Number.parseInt(text.trim().split(/\r?\n/, 1)[0] ?? "", 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

async function findTarget(port: number, targetId: string): Promise<ChromeTargetListEntry | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const targets = (await response.json()) as ChromeTargetListEntry[];
    return targets.find(
      (target) => target.id === targetId && (target.type === undefined || target.type === "page"),
    ) ?? null;
  } catch {
    return null;
  }
}

export function chatGptCompletionExpression(): string {
  return `(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const stopSelectors = [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]'
    ];
    const generating = stopSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(visible)
    );
    if (generating) return { state: 'generating' };

    const composer = document.querySelector('#prompt-textarea');
    if (!composer || !visible(composer)) return { state: 'unknown' };

    const assistantNodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const lastAssistant = assistantNodes[assistantNodes.length - 1];
    if (!(lastAssistant instanceof HTMLElement)) return { state: 'unknown' };
    const assistantText = (lastAssistant.innerText || lastAssistant.textContent || '').trim();
    if (!assistantText) return { state: 'unknown' };
    return { state: 'idle', assistantText };
  })()`;
}

function parseObservation(value: unknown): BrowserCompletionObservation {
  if (!value || typeof value !== "object") return { state: "unknown" };
  const record = value as { state?: unknown; assistantText?: unknown };
  if (record.state === "generating") return { state: "generating" };
  if (record.state === "idle" && typeof record.assistantText === "string" && record.assistantText.trim()) {
    return { state: "idle", assistantText: record.assistantText.trim() };
  }
  return { state: "unknown" };
}

async function evaluateCompletion(webSocketDebuggerUrl: string): Promise<BrowserCompletionObservation> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out inspecting ChatGPT worker completion state"));
    }, CDP_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Best-effort observer cleanup.
      }
      fn();
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression: chatGptCompletionExpression(),
          returnByValue: true,
        },
      }));
    }, { once: true });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as CdpResponse;
        if (message.id !== id) return;
        if (message.error) {
          finish(() => reject(new Error(message.error?.message ?? "CDP completion inspection failed")));
          return;
        }
        finish(() => resolve(parseObservation(message.result?.result?.value)));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });

    socket.addEventListener("error", () => {
      finish(() => reject(new Error("Could not inspect ChatGPT worker target")));
    }, { once: true });
  });
}

/**
 * Inspect an existing worker tab without starting/restarting Chrome. Two idle
 * samples must agree before the response is considered stably idle, reducing
 * false fallback detection between streaming/tool-call UI transitions.
 */
export function createChromeBrowserCompletionProbe(
  stateDir: string,
  stabilityMs = DEFAULT_STABILITY_MS,
): BrowserCompletionProbe {
  const profileDir = path.join(stateDir, "agents", "chrome-worker-profile");
  return {
    async inspect(browserHandle) {
      const targetId = targetIdFromHandle(browserHandle);
      if (!targetId) return { state: "unknown" };
      const port = await activeDevToolsPort(profileDir);
      if (!port) return { state: "unknown" };
      const target = await findTarget(port, targetId);
      if (!target?.webSocketDebuggerUrl) return { state: "unknown" };

      const first = await evaluateCompletion(target.webSocketDebuggerUrl);
      if (first.state !== "idle" || !first.assistantText) return first;
      await delay(Math.max(0, stabilityMs));
      const second = await evaluateCompletion(target.webSocketDebuggerUrl);
      if (
        second.state === "idle"
        && second.assistantText
        && second.assistantText === first.assistantText
      ) {
        return second;
      }
      if (second.state === "generating") return second;
      return { state: "unknown" };
    },
  };
}
