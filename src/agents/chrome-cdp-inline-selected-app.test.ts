import { describe, expect, it } from "vitest";
import {
  ChromeCdpBrowserWorkerDriver,
  type CdpConnection,
  type ChromePageTarget,
} from "./chrome-cdp.js";
import type { BrowserWorkerLaunchInput } from "./browser-controller.js";

function launchInput(): BrowserWorkerLaunchInput {
  return {
    workerId: "wrk_00000000-0000-0000-0000-000000000003",
    projectId: "project-1",
    task: "Read README and finish",
    workerToken: "wcap.wrk_00000000-0000-0000-0000-000000000003.secret",
    route: { mode: "standalone" },
  };
}

class InlineSelectedAppConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closed = false;

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Runtime.enable" || method === "Input.insertText" || method === "Input.dispatchKeyEvent") {
      return {};
    }
    if (method !== "Runtime.evaluate") return {};

    const expression = String(params?.expression ?? "");
    if (expression.includes("composer.querySelectorAll('a')")) {
      return { result: { value: true } };
    }
    if (expression.includes("current.trim() !== expected")) {
      return { result: { value: false } };
    }
    if (expression.includes("rect.width > 0")) {
      return { result: { value: true } };
    }
    if (expression.includes("composer.focus();")) {
      return { result: { value: true } };
    }
    if (expression.includes("current.trim().length === 0")) {
      return { result: { value: true } };
    }
    return { result: { value: undefined } };
  }

  close(): void {
    this.closed = true;
  }
}

describe("worker app inline selection", () => {
  it("recognizes ChatGPT's selected app anchor inside the ProseMirror composer", async () => {
    const connection = new InlineSelectedAppConnection();
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => ({ port: 9222 }),
      openTarget: async (_endpoint, url): Promise<ChromePageTarget> => ({
        id: "target-inline-app",
        url,
        webSocketDebuggerUrl: "ws://inline-app",
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
      browserHandle: "cdp:target-inline-app",
    });

    const inserted = connection.calls
      .filter((call) => call.method === "Input.insertText")
      .map((call) => String(call.params?.text ?? ""));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain("Read README and finish");
    expect(inserted[0]).not.toContain("@ChatGPT To Codex Worker");
    expect(connection.calls.some(
      (call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("composer.querySelectorAll('a')"),
    )).toBe(true);
    expect(connection.calls.some(
      (call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("candidate.click();"),
    )).toBe(false);
    expect(connection.calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(2);
    expect(connection.closed).toBe(true);
  });
});
