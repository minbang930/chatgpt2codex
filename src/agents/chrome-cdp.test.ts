import { describe, expect, it } from "vitest";
import {
  ChromeCdpBrowserWorkerDriver,
  buildWorkerBootstrap,
  type CdpConnection,
  type ChromeDevToolsEndpoint,
  type ChromePageTarget,
} from "./chrome-cdp.js";
import type { BrowserWorkerLaunchInput } from "./browser-controller.js";

function launchInput(route: BrowserWorkerLaunchInput["route"] = { mode: "standalone" }): BrowserWorkerLaunchInput {
  return {
    workerId: "wrk_00000000-0000-0000-0000-000000000001",
    projectId: "project-1",
    task: "Implement the SQLite migration and verify it",
    workerToken: "wcap.wrk_00000000-0000-0000-0000-000000000001.secret",
    route,
  };
}

class FakeConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closed = false;

  constructor(
    private readonly composerReady: boolean,
    private readonly appAvailable = true,
  ) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Runtime.enable") return {};
    if (method === "Input.dispatchKeyEvent" || method === "Input.insertText") return {};
    if (method !== "Runtime.evaluate") return {};

    const expression = String(params?.expression ?? "");
    if (expression.includes("rect.width > 0")) {
      return { result: { value: this.composerReady } };
    }
    if (expression.includes("candidate.click();")) {
      return { result: { value: { ok: this.appAvailable, text: this.appAvailable ? "ChatGPT To Codex Worker" : undefined } } };
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

describe("agents/chrome-cdp", () => {
  it("builds a worker bootstrap that confines the worker to worker tools and completion handshake", () => {
    const prompt = buildWorkerBootstrap(launchInput());
    expect(prompt).toContain("worker_project_rules");
    expect(prompt).toContain("worker_finish");
    expect(prompt).toContain("Do not call project_select");
    expect(prompt).toContain("dedicated ChatGPT To Codex Worker app");
    expect(prompt).toContain("wcap.wrk_00000000-0000-0000-0000-000000000001.secret");
    expect(prompt).toContain("Implement the SQLite migration and verify it");
  });

  it("selects the dedicated worker app before submitting a standalone worker bootstrap", async () => {
    const endpoint: ChromeDevToolsEndpoint = { port: 9222 };
    const connection = new FakeConnection(true);
    const opened: string[] = [];
    const closedTargets: string[] = [];
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => endpoint,
      openTarget: async (_endpoint, url): Promise<ChromePageTarget> => {
        opened.push(url);
        return { id: "target-1", url, webSocketDebuggerUrl: "ws://target-1" };
      },
      closeTarget: async (_endpoint, targetId) => {
        closedTargets.push(targetId);
      },
      connect: async () => connection,
      sleepMs: async () => undefined,
      composerAttempts: 1,
      composerPollMs: 0,
      appMentionAttempts: 1,
      appMentionPollMs: 0,
    });

    const result = await driver.launch(launchInput());
    expect(result.browserHandle).toBe("cdp:target-1");
    expect(opened).toEqual(["https://chatgpt.com/"]);
    expect(closedTargets).toEqual([]);
    expect(connection.closed).toBe(true);

    const insertedText = connection.calls
      .filter((call) => call.method === "Input.insertText")
      .map((call) => String(call.params?.text ?? ""));
    expect(insertedText[0]).toBe("@ChatGPT To Codex Worker");
    expect(insertedText[1]).toContain("Implement the SQLite migration and verify it");
    expect(insertedText[1]).toContain("wcap.wrk_00000000-0000-0000-0000-000000000001.secret");

    const appSelection = connection.calls.find(
      (call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("candidate.click();"),
    );
    expect(String(appSelection?.params?.expression)).toContain("ChatGPT To Codex Worker");
    expect(connection.calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });

  it("supports an explicitly configured worker app name", async () => {
    const connection = new FakeConnection(true);
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => ({ port: 9222 }),
      openTarget: async (_endpoint, url) => ({ id: "target-custom-app", url, webSocketDebuggerUrl: "ws://custom-app" }),
      closeTarget: async () => undefined,
      connect: async () => connection,
      sleepMs: async () => undefined,
      composerAttempts: 1,
      composerPollMs: 0,
      workerAppName: "C2C Worker Dev",
      appMentionAttempts: 1,
      appMentionPollMs: 0,
    });

    await driver.launch(launchInput());
    const mentions = connection.calls.filter((call) => call.method === "Input.insertText");
    expect(mentions[0]?.params?.text).toBe("@C2C Worker Dev");
    const selection = connection.calls.find(
      (call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("candidate.click();"),
    );
    expect(String(selection?.params?.expression)).toContain("C2C Worker Dev");
  });

  it("fails closed when the dedicated worker app is not available", async () => {
    const connection = new FakeConnection(true, false);
    const closedTargets: string[] = [];
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => ({ port: 9222 }),
      openTarget: async (_endpoint, url) => ({ id: "target-no-app", url, webSocketDebuggerUrl: "ws://no-app" }),
      closeTarget: async (_endpoint, targetId) => {
        closedTargets.push(targetId);
      },
      connect: async () => connection,
      sleepMs: async () => undefined,
      composerAttempts: 1,
      composerPollMs: 0,
      appMentionAttempts: 1,
      appMentionPollMs: 0,
    });

    await expect(driver.launch(launchInput())).rejects.toThrow(/custom app.*\/mcp\/worker/i);
    expect(closedTargets).toEqual(["target-no-app"]);
    expect(connection.calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(0);
    expect(connection.closed).toBe(true);
  });

  it("prefers the mapped ChatGPT Project and falls back to standalone when its composer is unavailable", async () => {
    const endpoint: ChromeDevToolsEndpoint = { port: 9222 };
    const projectConnection = new FakeConnection(false);
    const standaloneConnection = new FakeConnection(true);
    const opened: string[] = [];
    const closedTargets: string[] = [];
    let targetNumber = 0;
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => endpoint,
      openTarget: async (_endpoint, url) => {
        targetNumber += 1;
        opened.push(url);
        return {
          id: `target-${targetNumber}`,
          url,
          webSocketDebuggerUrl: `ws://target-${targetNumber}`,
        };
      },
      closeTarget: async (_endpoint, targetId) => {
        closedTargets.push(targetId);
      },
      connect: async (url) => (url.endsWith("target-1") ? projectConnection : standaloneConnection),
      sleepMs: async () => undefined,
      composerAttempts: 1,
      composerPollMs: 0,
      appMentionAttempts: 1,
      appMentionPollMs: 0,
    });

    const result = await driver.launch(
      launchInput({
        mode: "project",
        projectRef: { url: "https://chatgpt.com/g/g-p-example/project", label: "Mapped Project" },
      }),
    );

    expect(result).toMatchObject({ browserHandle: "cdp:target-2", fallbackUsed: true });
    expect(opened).toEqual([
      "https://chatgpt.com/g/g-p-example/project",
      "https://chatgpt.com/",
    ]);
    expect(closedTargets).toContain("target-1");
    expect(projectConnection.closed).toBe(true);
    expect(standaloneConnection.closed).toBe(true);
  });

  it("fails with a sign-in hint and closes the tab when no ChatGPT composer is available", async () => {
    const connection = new FakeConnection(false);
    const closedTargets: string[] = [];
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => ({ port: 9222 }),
      openTarget: async (_endpoint, url) => ({ id: "target-login", url, webSocketDebuggerUrl: "ws://login" }),
      closeTarget: async (_endpoint, targetId) => {
        closedTargets.push(targetId);
      },
      connect: async () => connection,
      sleepMs: async () => undefined,
      composerAttempts: 1,
      composerPollMs: 0,
      appMentionAttempts: 1,
      appMentionPollMs: 0,
    });

    await expect(driver.launch(launchInput())).rejects.toThrow(/Sign in to ChatGPT/);
    expect(closedTargets).toEqual(["target-login"]);
    expect(connection.closed).toBe(true);
  });

  it("closes a CDP worker tab on cancel without depending on ChatGPT conversation identity", async () => {
    const closedTargets: string[] = [];
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => ({ port: 9222 }),
      openTarget: async () => {
        throw new Error("not used");
      },
      closeTarget: async (_endpoint, targetId) => {
        closedTargets.push(targetId);
      },
      connect: async () => {
        throw new Error("not used");
      },
    });

    await driver.cancel({ workerId: "wrk_00000000-0000-0000-0000-000000000001", browserHandle: "cdp:target-77" });
    await driver.cancel({ workerId: "wrk_00000000-0000-0000-0000-000000000001", browserHandle: "other:target" });
    expect(closedTargets).toEqual(["target-77"]);
  });
});
