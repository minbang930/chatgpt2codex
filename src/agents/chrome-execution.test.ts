import { describe, expect, it } from "vitest";
import { applyWorkerExecutionIntent } from "./chrome-execution.js";
import type { CdpConnection } from "./chrome-cdp.js";
import type { WorkerExecutionIntent } from "./execution-settings.js";

interface FakeOptions {
  modelAvailable?: boolean;
  modelClickMaterializes?: boolean;
  sliderClickMaterializes?: boolean;
  sliderMax?: number;
  selectedModel?: string;
  sliderValue?: number;
  requireRolelessNeutralControl?: boolean;
}

class FakeExecutionConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  menuOpen = false;
  selectedModel: string;
  sliderValue: number;
  private pendingPoint: "control" | "model" | "slider" | undefined;
  private pendingSliderTarget: number | undefined;

  constructor(private readonly options: FakeOptions = {}) {
    this.selectedModel = options.selectedModel ?? "GPT-5.6 Luna";
    this.sliderValue = options.sliderValue ?? 0;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression.includes("C2C_EXECUTION_CONTROL")) {
        if (
          this.options.requireRolelessNeutralControl
          && !expression.includes('button.__composer-pill.__composer-pill--neutral[aria-haspopup="menu"]')
        ) {
          return { result: { value: null } };
        }
        this.pendingPoint = "control";
        return { result: { value: { x: 10, y: 10 } } };
      }
      if (expression.includes("C2C_EXECUTION_SLIDER_POINT")) {
        this.pendingPoint = "slider";
        const match = expression.match(/const target = (\d+);/u);
        this.pendingSliderTarget = match ? Number(match[1]) : undefined;
        return { result: { value: { x: 30, y: 30 } } };
      }
      if (expression.includes("C2C_EXECUTION_SURFACE")) {
        if (!this.menuOpen) {
          return { result: { value: { menuOpen: false, modelOptionCount: 0 } } };
        }
        const targetRequested = expression.includes('const target = "GPT-5.6 Sol"');
        const modelAvailable = this.options.modelAvailable ?? true;
        this.pendingPoint = targetRequested && modelAvailable ? "model" : undefined;
        return {
          result: {
            value: {
              menuOpen: true,
              selectedModel: this.selectedModel,
              modelSelected: targetRequested && this.selectedModel === "GPT-5.6 Sol",
              modelOptionCount: targetRequested && modelAvailable ? 1 : 0,
              modelOptionPoint: targetRequested && modelAvailable ? { x: 20, y: 20 } : undefined,
              slider: {
                min: 0,
                max: this.options.sliderMax ?? 3,
                value: this.sliderValue,
              },
            },
          },
        };
      }
      return { result: { value: undefined } };
    }

    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
      const x = Number(params.x);
      if (x === 10) {
        this.menuOpen = true;
      } else if (x === 20) {
        if (this.options.modelClickMaterializes ?? true) this.selectedModel = "GPT-5.6 Sol";
        this.menuOpen = false;
      } else if (x === 30) {
        if ((this.options.sliderClickMaterializes ?? true) && this.pendingSliderTarget !== undefined) {
          this.sliderValue = this.pendingSliderTarget;
        }
      }
      this.pendingPoint = undefined;
      return {};
    }

    if (method === "Input.dispatchKeyEvent" && params?.key === "Escape" && params?.type === "keyUp") {
      this.menuOpen = false;
      return {};
    }
    return {};
  }

  close(): void {}
}

function intent(
  resolved: NonNullable<WorkerExecutionIntent["resolved"]>,
): WorkerExecutionIntent {
  return { resolved };
}

const noSleep = async () => undefined;

describe("agents/chrome-execution", () => {
  it("selects and post-verifies an explicit model and reasoning effort", async () => {
    const connection = new FakeExecutionConnection();
    const result = await applyWorkerExecutionIntent(
      connection,
      intent({
        model: "GPT-5.6 Sol",
        reasoningEffort: "high",
        fallbackPolicy: "fail-closed",
      }),
      noSleep,
    );

    expect(result).toEqual({
      verified: true,
      observedModel: "GPT-5.6 Sol",
      observedReasoningEffort: "high",
    });
    expect(connection.selectedModel).toBe("GPT-5.6 Sol");
    expect(connection.sliderValue).toBe(2);
    expect(connection.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length).toBeGreaterThanOrEqual(6);
  });

  it("recognizes the current role-less neutral composer pill without relying on a label", async () => {
    const connection = new FakeExecutionConnection({
      selectedModel: "GPT-5.6 Sol",
      sliderValue: 2,
      requireRolelessNeutralControl: true,
    });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "high", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).resolves.toEqual({
      verified: true,
      observedReasoningEffort: "high",
    });
  });

  it("fails closed when the requested model is unavailable", async () => {
    const connection = new FakeExecutionConnection({ modelAvailable: false });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ model: "GPT-5.6 Sol", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).rejects.toThrow(/unavailable or ambiguous/i);
  });

  it("fails closed when a model click does not materialize the selected model", async () => {
    const connection = new FakeExecutionConnection({ modelClickMaterializes: false });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ model: "GPT-5.6 Sol", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).rejects.toThrow(/did not verify/i);
  });

  it("fails closed when an effort click does not change the structural slider state", async () => {
    const connection = new FakeExecutionConnection({
      selectedModel: "GPT-5.6 Sol",
      sliderClickMaterializes: false,
    });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "high", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).rejects.toThrow(/did not verify/i);
  });

  it("rejects extra-high when the current account exposes only three slider positions", async () => {
    const connection = new FakeExecutionConnection({ sliderMax: 2 });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "extra-high", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).rejects.toThrow(/unavailable in the current account\/profile/i);
  });

  it("allows current execution state only when the persisted fallback policy explicitly permits it", async () => {
    const connection = new FakeExecutionConnection({ sliderMax: 2 });
    const result = await applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "extra-high", fallbackPolicy: "allow-current" }),
      noSleep,
    );

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/unavailable/i);
  });

  it("does not touch ChatGPT execution controls for an unmanaged worker", async () => {
    const connection = new FakeExecutionConnection();
    expect(await applyWorkerExecutionIntent(connection, undefined, noSleep)).toEqual({ verified: true });
    expect(connection.calls).toEqual([]);
  });
});
