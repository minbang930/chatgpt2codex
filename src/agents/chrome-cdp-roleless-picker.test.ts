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

class FakeElement {
  clicked = false;

  constructor(
    readonly textContent: string,
    private readonly children: FakeElement[] = [],
    private readonly attributes: Record<string, string> = {},
  ) {}

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 320, height: 36 };
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "*") {
      return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    }
    return [];
  }

  click(): void {
    this.clicked = true;
  }
}

class RolelessPickerConnection implements CdpConnection {
  closed = false;

  readonly title = new FakeElement("ChatGPT To Codex Worker");
  readonly subtitle = new FakeElement("chatgpt2codex worker");
  readonly row = new FakeElement(
    "ChatGPT To Codex Worker chatgpt2codex worker",
    [this.title, this.subtitle],
  );

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "Runtime.enable" || method === "Input.insertText" || method === "Input.dispatchKeyEvent") {
      return {};
    }
    if (method !== "Runtime.evaluate") return {};

    const expression = String(params?.expression ?? "");
    if (expression.includes("candidate.click();")) {
      const fakeDocument = {
        querySelectorAll: (selector: string) => selector === ".popover .__menu-item" ? [this.row] : [],
      };
      const fakeWindow = {
        getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      };
      const evaluate = new Function(
        "document",
        "HTMLElement",
        "window",
        `return ${expression};`,
      ) as (document: unknown, HTMLElement: unknown, window: unknown) => unknown;
      return {
        result: {
          value: evaluate(fakeDocument, FakeElement, fakeWindow),
        },
      };
    }
    if (expression.includes("rect.width > 0")) return { result: { value: true } };
    if (expression.includes("inlineSelectedApp")) return { result: { value: this.row.clicked } };
    if (expression.includes("composer.focus();")) return { result: { value: true } };
    if (expression.includes("current.trim().length === 0")) return { result: { value: true } };
    return { result: { value: undefined } };
  }

  close(): void {
    this.closed = true;
  }
}

describe("worker app roleless picker matching", () => {
  it("clicks the unique roleless popover menu row with an exact app-name descendant", async () => {
    const connection = new RolelessPickerConnection();
    const driver = new ChromeCdpBrowserWorkerDriver({
      ensureEndpoint: async () => ({ port: 9222 }),
      openTarget: async (_endpoint, url): Promise<ChromePageTarget> => ({
        id: "target-roleless-picker",
        url,
        webSocketDebuggerUrl: "ws://roleless-picker",
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
      browserHandle: "cdp:target-roleless-picker",
    });
    expect(connection.row.clicked).toBe(true);
    expect(connection.closed).toBe(true);
  });
});
