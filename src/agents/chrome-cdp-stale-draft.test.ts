import { describe, expect, it } from "vitest";
import {
  ChromeCdpBrowserWorkerDriver,
  type CdpConnection,
  type ChromePageTarget,
} from "./chrome-cdp.js";
import type { BrowserWorkerLaunchInput } from "./browser-controller.js";

function launchInput(): BrowserWorkerLaunchInput {
  return {
    workerId: "wrk_00000000-0000-0000-0000-000000000002",
    projectId: "project-1",
    task: "Read README and finish",
    workerToken: "wcap.wrk_00000000-0000-0000-0000-000000000002.secret",
    route: { mode: "standalone" },
  };
}

class StaleDraftConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closed = false;
  selected = false;
  staleDraft = true;

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Runtime.enable" || method === "Input.dispatchKeyEvent") return {};

    if (method === "Input.insertText") {
      const text = String(params?.text ?? "");
      if (text === "@ChatGPT To Codex Worker" && this.staleDraft) {
        throw new Error("worker app mention was inserted before stale draft cleanup");
      }
      return {};
    }

    if (method !== "Runtime.evaluate") return {};
    const expression = String(params?.expression ?? "");

    if (expression.includes("current.trim() !== expected")) {
      if (this.staleDraft) {
        this.staleDraft = false;
        return { result: { value: true } };
      }
      return { result: { value: false } };
    }
    if (expression.includes("candidate.click();")) {
      this.selected = true;
      return { result: { value: { ok: true } } };
    }
    if (expression.includes("inlineSelectedApp") || expression.includes("suggestionRootSelector")) {
      return { result: { value: this.selected } };
    }
    if (expression.includes("rect.width > 0")) return { result: { value: true } };
    if (expression.includes("composer.focus();")) return { result: { value: true } };
    if (expression.includes("current.trim().length === 0")) return { result: { value: true } };
    return { result: { value: undefined } };
  }

  close(): void {
    this.closed = true;
  }
}

describe("worker app stale draft recovery", () => {
  it("clears an exact stale plain-text worker app query before typing a fresh mention", async () => {
    const connection = new StaleDraftConnection();
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => ({ port: 9222 }),
      openTarget: async (_endpoint, url): Promise<ChromePageTarget> => ({
        id: "target-stale-draft",
        url,
        webSocketDebuggerUrl: "ws://stale-draft",
      }),
      closeTarget: async () => undefined,
      connect: async () => connection,
      sleepMs: async () => undefined,
      composerAttempts: 1,
      composerPollMs: 0,
      appMentionAttempts: 1,
      appMentionPollMs: 0,
    });

    await expect(driver.launch(launchInput())).resolves.toMatchObject({
      browserHandle: "cdp:target-stale-draft",
    });

    const inserted = connection.calls
      .filter((call) => call.method === "Input.insertText")
      .map((call) => String(call.params?.text ?? ""));
    expect(inserted[0]).toBe("@ChatGPT To Codex Worker");
    expect(inserted[1]).toContain("Read README and finish");
    expect(connection.staleDraft).toBe(false);
    expect(connection.selected).toBe(true);
    expect(connection.closed).toBe(true);
  });
});
