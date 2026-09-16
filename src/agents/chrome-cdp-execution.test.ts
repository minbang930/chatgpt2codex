import { describe, expect, it } from "vitest";
import {
  ChromeCdpBrowserWorkerDriver,
  type CdpConnection,
} from "./chrome-cdp.js";
import type { BrowserWorkerLaunchInput } from "./browser-controller.js";

class ExecutionAwareConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closed = false;
  menuOpen = false;
  sliderValue = 0;
  appSelected = false;
  private sliderFocused = false;

  constructor(private readonly sliderMax = 3) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Runtime.enable") return {};

    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
      const x = Number(params.x);
      if (x === 10) this.menuOpen = true;
      return {};
    }

    if (method === "Input.dispatchKeyEvent") {
      const key = String(params?.key ?? "");
      if (key === "Escape" && params?.type === "keyUp") {
        this.menuOpen = false;
        this.sliderFocused = false;
        return {};
      }
      if (params?.type === "keyUp" && this.sliderFocused && (key === "ArrowRight" || key === "ArrowLeft")) {
        this.sliderValue = key === "ArrowRight"
          ? Math.min(this.sliderMax, this.sliderValue + 1)
          : Math.max(0, this.sliderValue - 1);
      }
      return {};
    }
    if (method === "Input.insertText") return {};
    if (method !== "Runtime.evaluate") return {};

    const expression = String(params?.expression ?? "");
    if (expression.includes("C2C_EXECUTION_CONTROL")) {
      return { result: { value: { x: 10, y: 10 } } };
    }
    if (expression.includes("C2C_EXECUTION_SLIDER_FOCUS")) {
      this.sliderFocused = this.menuOpen;
      return { result: { value: this.sliderFocused } };
    }
    if (expression.includes("C2C_EXECUTION_SURFACE")) {
      return {
        result: {
          value: this.menuOpen
            ? {
                menuOpen: true,
                modelOptionCount: 0,
                slider: { min: 0, max: this.sliderMax, value: this.sliderValue },
              }
            : { menuOpen: false, modelOptionCount: 0 },
        },
      };
    }
    if (expression.includes("candidate.click();")) {
      this.appSelected = true;
      return { result: { value: { ok: true, text: "ChatGPT To Codex Worker" } } };
    }
    if (expression.includes("inlineSelectedApp")) {
      return { result: { value: this.appSelected } };
    }
    if (expression.includes("rect.width > 0")) {
      return { result: { value: true } };
    }
    if (expression.includes("composer.focus();")) {
      return { result: { value: true } };
    }
    if (expression.includes("current.trim() !== expected")) {
      return { result: { value: false } };
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

function launchInput(): BrowserWorkerLaunchInput {
  return {
    workerId: "wrk_00000000-0000-0000-0000-000000000031",
    projectId: "project-execution",
    task: "Verify execution before worker bootstrap",
    workerToken: "wcap.wrk_00000000-0000-0000-0000-000000000031.secret",
    executionIntent: {
      resolved: {
        reasoningEffort: "high",
        fallbackPolicy: "fail-closed",
      },
    },
    route: { mode: "standalone" },
  };
}

function makeDriver(connection: ExecutionAwareConnection, closedTargets: string[] = []) {
  return new ChromeCdpBrowserWorkerDriver({
    ensureEndpoint: async () => ({ port: 9222 }),
    openTarget: async (_endpoint, url) => ({
      id: "target-execution",
      url,
      webSocketDebuggerUrl: "ws://target-execution",
    }),
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
}

describe("Chrome worker execution integration", () => {
  it("verifies durable execution intent before selecting the Worker app or inserting bootstrap text", async () => {
    const connection = new ExecutionAwareConnection();
    const result = await makeDriver(connection).launch(launchInput());

    expect(result.browserHandle).toBe("cdp:target-execution");
    expect(connection.sliderValue).toBe(2);
    const executionIndex = connection.calls.findIndex(
      (call) => call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("C2C_EXECUTION_"),
    );
    const firstInsertIndex = connection.calls.findIndex((call) => call.method === "Input.insertText");
    expect(executionIndex).toBeGreaterThanOrEqual(0);
    expect(firstInsertIndex).toBeGreaterThan(executionIndex);
    expect(connection.calls[firstInsertIndex]?.params?.text).toBe("@ChatGPT To Codex Worker");
    expect(connection.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent"
        && call.params?.type === "keyUp"
        && call.params?.key === "ArrowRight",
    )).toHaveLength(2);
    expect(connection.calls.filter((call) => call.method === "Input.dispatchKeyEvent" && call.params?.key === "Enter")).toHaveLength(2);
  });

  it("fails before Worker-app selection and submission when explicit execution intent cannot be verified", async () => {
    const connection = new ExecutionAwareConnection(1);
    const closedTargets: string[] = [];

    await expect(makeDriver(connection, closedTargets).launch(launchInput())).rejects.toThrow(/unavailable/i);
    expect(closedTargets).toEqual(["target-execution"]);
    expect(connection.calls.filter((call) => call.method === "Input.insertText")).toHaveLength(0);
    expect(connection.calls.filter((call) => call.method === "Input.dispatchKeyEvent" && call.params?.key === "Enter")).toHaveLength(0);
    expect(connection.closed).toBe(true);
  });
});
