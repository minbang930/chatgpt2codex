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

class SelectedAppConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closed = false;

  constructor(
    private selected: boolean,
    private readonly candidateReturnsOk: boolean,
  ) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Runtime.enable" || method === "Input.insertText" || method === "Input.dispatchKeyEvent") {
      return {};
    }
    if (method !== "Runtime.evaluate") return {};

    const expression = String(params?.expression ?? "");
    if (expression.includes("candidate.click();")) {
      this.selected = true;
      return { result: { value: { ok: this.candidateReturnsOk } } };
    }
    if (expression.includes("suggestionRootSelector")) {
      return { result: { value: this.selected } };
    }
    if (expression.includes("current.trim() !== expected")) {
      return { result: { value: true } };
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

function driverFor(connection: CdpConnection): ChromeCdpBrowserWorkerDriver {
  return new ChromeCdpBrowserWorkerDriver({
    ensureEndpoint: async () => ({ port: 9222 }),
    openTarget: async (_endpoint, url): Promise<ChromePageTarget> => ({
      id: "target-selected-app",
      url,
      webSocketDebuggerUrl: "ws://selected-app",
    }),
    closeTarget: async () => undefined,
    connect: async () => connection,
    sleepMs: async () => undefined,
    composerAttempts: 1,
    composerPollMs: 0,
    appMentionAttempts: 1,
    appMentionPollMs: 0,
  });
}

describe("worker app selected-chip recovery", () => {
  it("continues when clicking the app row selects the chip even if the click evaluation reports no success", async () => {
    const connection = new SelectedAppConnection(false, false);

    await expect(driverFor(connection).launch(launchInput())).resolves.toMatchObject({
      browserHandle: "cdp:target-selected-app",
    });

    const inserted = connection.calls
      .filter((call) => call.method === "Input.insertText")
      .map((call) => String(call.params?.text ?? ""));
    expect(inserted[0]).toBe("@ChatGPT To Codex Worker");
    expect(inserted[1]).toContain("Read README and finish");
    expect(connection.calls.some(
      (call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("suggestionRootSelector"),
    )).toBe(true);
    expect(connection.calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(2);
    expect(connection.closed).toBe(true);
  });

  it("reuses an already-selected app chip without typing a second @ mention", async () => {
    const connection = new SelectedAppConnection(true, false);

    await expect(driverFor(connection).launch(launchInput())).resolves.toMatchObject({
      browserHandle: "cdp:target-selected-app",
    });

    const inserted = connection.calls
      .filter((call) => call.method === "Input.insertText")
      .map((call) => String(call.params?.text ?? ""));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain("Read README and finish");
    expect(inserted[0]).not.toContain("@ChatGPT To Codex Worker");
    expect(connection.calls.some(
      (call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("candidate.click();"),
    )).toBe(false);
    expect(connection.closed).toBe(true);
  });
});
