import { describe, expect, it } from "vitest";
import { applyWorkerExecutionIntent } from "./chrome-execution.js";
import type { CdpConnection } from "./chrome-cdp.js";
import type { WorkerExecutionIntent } from "./execution-settings.js";

interface FakeOptions {
  modelAvailable?: boolean;
  modelClickMaterializes?: boolean;
  sliderKeyboardMaterializes?: boolean;
  sliderIgnoredKeyUps?: number;
  sliderMax?: number;
  selectedModel?: string;
  sliderValue?: number;
  requireRolelessNeutralControl?: boolean;
  controlUnavailableEvaluations?: number;
  sliderUnavailableEvaluations?: number;
}

class FakeExecutionConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  menuOpen = false;
  selectedModel: string;
  sliderValue: number;
  private pendingPoint: "control" | "model" | undefined;
  private controlEvaluations = 0;
  private sliderEvaluations = 0;
  private sliderFocused = false;
  private sliderArrowKeyUps = 0;

  constructor(private readonly options: FakeOptions = {}) {
    this.selectedModel = options.selectedModel ?? "GPT-5.6 Luna";
    this.sliderValue = options.sliderValue ?? 0;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression.includes("C2C_EXECUTION_CONTROL")) {
        this.controlEvaluations += 1;
        if (this.controlEvaluations <= (this.options.controlUnavailableEvaluations ?? 0)) {
          return { result: { value: null } };
        }
        if (
          this.options.requireRolelessNeutralControl
          && !expression.includes('button.__composer-pill.__composer-pill--neutral[aria-haspopup="menu"]')
        ) {
          return { result: { value: null } };
        }
        this.pendingPoint = "control";
        return { result: { value: { x: 10, y: 10 } } };
      }
      if (expression.includes("C2C_EXECUTION_SLIDER_FOCUS")) {
        this.sliderFocused = this.menuOpen;
        return { result: { value: this.sliderFocused } };
      }
      if (expression.includes("C2C_EXECUTION_SURFACE")) {
        if (!this.menuOpen) {
          return { result: { value: { menuOpen: false, modelOptionCount: 0 } } };
        }
        const targetRequested = expression.includes('const target = "GPT-5.6 Sol"');
        const modelAvailable = this.options.modelAvailable ?? true;
        const reasoningObservation = expression.includes('const target = "";');
        if (reasoningObservation) this.sliderEvaluations += 1;
        const sliderAvailable = !reasoningObservation
          || this.sliderEvaluations > (this.options.sliderUnavailableEvaluations ?? 0);
        this.pendingPoint = targetRequested && modelAvailable ? "model" : undefined;
        return {
          result: {
            value: {
              menuOpen: true,
              selectedModel: this.selectedModel,
              modelSelected: targetRequested && this.selectedModel === "GPT-5.6 Sol",
              modelOptionCount: targetRequested && modelAvailable ? 1 : 0,
              modelOptionPoint: targetRequested && modelAvailable ? { x: 20, y: 20 } : undefined,
              ...(sliderAvailable
                ? {
                    slider: {
                      min: 0,
                      max: this.options.sliderMax ?? 3,
                      value: this.sliderValue,
                    },
                  }
                : {}),
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
        this.sliderFocused = false;
      }
      this.pendingPoint = undefined;
      return {};
    }

    if (method === "Input.dispatchKeyEvent" && params?.type === "keyUp") {
      const key = String(params.key ?? "");
      if (key === "Escape") {
        this.menuOpen = false;
        this.sliderFocused = false;
        return {};
      }
      if (key === "ArrowRight" || key === "ArrowLeft") {
        this.sliderArrowKeyUps += 1;
      }
      if (
        this.sliderFocused
        && (this.options.sliderKeyboardMaterializes ?? true)
        && this.sliderArrowKeyUps > (this.options.sliderIgnoredKeyUps ?? 0)
        && (key === "ArrowRight" || key === "ArrowLeft")
      ) {
        const max = this.options.sliderMax ?? 3;
        this.sliderValue = key === "ArrowRight"
          ? Math.min(max, this.sliderValue + 1)
          : Math.max(0, this.sliderValue - 1);
      }
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
    expect(connection.calls.some(
      (call) => call.method === "Runtime.evaluate"
        && String(call.params?.expression ?? "").includes("C2C_EXECUTION_SLIDER_FOCUS"),
    )).toBe(true);
    expect(connection.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent"
        && call.params?.type === "keyUp"
        && call.params?.key === "ArrowRight",
    )).toHaveLength(2);
  });

  it("moves from medium to high with one structural slider key step", async () => {
    const connection = new FakeExecutionConnection({
      selectedModel: "GPT-5.6 Sol",
      sliderValue: 1,
    });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "high", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).resolves.toEqual({
      verified: true,
      observedReasoningEffort: "high",
    });
    expect(connection.sliderValue).toBe(2);
    expect(connection.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent"
        && call.params?.type === "keyUp"
        && call.params?.key === "ArrowRight",
    )).toHaveLength(1);
  });

  it("retries a dropped medium-to-high slider key step before failing closed", async () => {
    const connection = new FakeExecutionConnection({
      selectedModel: "GPT-5.6 Sol",
      sliderValue: 1,
      sliderIgnoredKeyUps: 1,
    });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "high", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).resolves.toEqual({
      verified: true,
      observedReasoningEffort: "high",
    });
    expect(connection.sliderValue).toBe(2);
    expect(connection.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent"
        && call.params?.type === "keyUp"
        && call.params?.key === "ArrowRight",
    )).toHaveLength(2);
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

  it("waits for the execution control to hydrate before failing closed", async () => {
    const connection = new FakeExecutionConnection({
      selectedModel: "GPT-5.6 Sol",
      sliderValue: 2,
      controlUnavailableEvaluations: 3,
    });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "high", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).resolves.toEqual({
      verified: true,
      observedReasoningEffort: "high",
    });
    expect(connection.calls.filter(
      (call) => call.method === "Runtime.evaluate"
        && String(call.params?.expression ?? "").includes("C2C_EXECUTION_CONTROL"),
    )).toHaveLength(4);
  });

  it("waits for the structural reasoning slider to hydrate after the picker opens", async () => {
    const connection = new FakeExecutionConnection({
      selectedModel: "GPT-5.6 Sol",
      sliderValue: 2,
      sliderUnavailableEvaluations: 3,
    });

    await expect(applyWorkerExecutionIntent(
      connection,
      intent({ reasoningEffort: "high", fallbackPolicy: "fail-closed" }),
      noSleep,
    )).resolves.toEqual({
      verified: true,
      observedReasoningEffort: "high",
    });
    expect(connection.calls.filter(
      (call) => call.method === "Runtime.evaluate"
        && String(call.params?.expression ?? "").includes("C2C_EXECUTION_SURFACE")
        && String(call.params?.expression ?? "").includes('const target = "";'),
    ).length).toBeGreaterThanOrEqual(4);
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

  it("fails closed when effort keyboard interaction does not change the structural slider state", async () => {
    const connection = new FakeExecutionConnection({
      selectedModel: "GPT-5.6 Sol",
      sliderKeyboardMaterializes: false,
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
