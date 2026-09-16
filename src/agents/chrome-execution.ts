import { DomainError, ErrorCode } from "../types.js";
import type {
  WorkerExecutionIntent,
  WorkerReasoningEffort,
} from "./execution-settings.js";
import type { CdpConnection } from "./chrome-cdp.js";

const EXECUTION_MENU_ATTEMPTS = 20;
const EXECUTION_MENU_POLL_MS = 100;
const EXECUTION_VERIFY_ATTEMPTS = 12;
const EXECUTION_VERIFY_POLL_MS = 100;

interface Point {
  x: number;
  y: number;
}

interface ExecutionSliderState {
  min: number;
  max: number;
  value: number;
  valueText?: string;
}

interface ExecutionSurface {
  menuOpen: boolean;
  selectedModel?: string;
  modelSelected?: boolean;
  modelOptionCount: number;
  modelOptionPoint?: Point;
  slider?: ExecutionSliderState;
}

export interface WorkerExecutionApplyResult {
  verified: boolean;
  observedModel?: string;
  observedReasoningEffort?: WorkerReasoningEffort;
  error?: string;
}

interface CdpEvaluateResult {
  result?: {
    value?: unknown;
  };
}

function resultValue(value: unknown): unknown {
  return (value as CdpEvaluateResult | undefined)?.result?.value;
}

function normalizeLabel(value: string | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function labelsMatch(actual: string | undefined, expected: string): boolean {
  return normalizeLabel(actual) === normalizeLabel(expected);
}

function effortOffset(effort: WorkerReasoningEffort): number {
  switch (effort) {
    case "instant": return 0;
    case "medium": return 1;
    case "high": return 2;
    case "extra-high": return 3;
  }
}

function effortForSliderValue(slider: ExecutionSliderState | undefined): WorkerReasoningEffort | undefined {
  if (!slider) return undefined;
  const offset = slider.value - slider.min;
  if (offset === 0) return "instant";
  if (offset === 1) return "medium";
  if (offset === 2) return "high";
  if (offset === 3) return "extra-high";
  return undefined;
}

function executionControlExpression(): string {
  return `(() => {
    /* C2C_EXECUTION_CONTROL */
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const composer = document.querySelector('#prompt-textarea');
    if (!(composer instanceof HTMLElement)) return null;
    const scope = composer.closest('form') || document.body;
    const point = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const uniqueVisible = (selector) => Array.from(scope.querySelectorAll(selector)).filter(visible);

    const testId = uniqueVisible('button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]');
    if (testId.length === 1) return point(testId[0]);

    // Current ChatGPT unified intelligence picker exposes a neutral composer pill.
    // Prefer this structural signal because recent UI revisions removed the model-switcher test id.
    const neutral = uniqueVisible('button[aria-haspopup="menu"][data-tone="neutral"]');
    if (neutral.length === 1) return point(neutral[0]);

    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const modelish = uniqueVisible('button.__composer-pill[aria-haspopup="menu"]').filter((element) => {
      const label = normalize((element.getAttribute('aria-label') || '') + ' ' + (element.textContent || ''));
      return /(?:chatgpt|gpt|instant|thinking|pro|latest|sol|luna|medium|high)/u.test(label);
    });
    if (modelish.length === 1) return point(modelish[0]);

    const composerPills = uniqueVisible('button.__composer-pill[aria-haspopup="menu"]');
    if (composerPills.length === 1) return point(composerPills[0]);
    return null;
  })()`;
}

function executionSurfaceExpression(targetModel?: string): string {
  const target = JSON.stringify(targetModel ?? "");
  return `(() => {
    /* C2C_EXECUTION_SURFACE */
    const target = ${target};
    const normalize = (value) => String(value || '')
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const expected = normalize(target);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const roots = Array.from(document.querySelectorAll(
      '[data-testid="composer-intelligence-picker-content"], [role="menu"], [role="group"], [role="dialog"], [data-radix-popper-content-wrapper]'
    )).filter(visible);
    const root = roots.find((candidate) => candidate.querySelector(
      '[role="menuitemradio"], [role="radio"], [data-model-reasoning-effort-slider]'
    ));
    if (!(root instanceof HTMLElement)) {
      return { menuOpen: false, modelOptionCount: 0 };
    }

    const selected = Array.from(root.querySelectorAll(
      '[role="menuitemradio"][aria-checked="true"], [role="radio"][aria-checked="true"], [role="option"][aria-selected="true"]'
    )).find(visible);
    const selectedModel = selected instanceof HTMLElement
      ? String(selected.getAttribute('aria-label') || selected.textContent || '').replace(/\\s+/g, ' ').trim()
      : undefined;

    const candidates = Array.from(root.querySelectorAll(
      '[role="menuitemradio"], [role="radio"], [role="option"], [role="menuitem"]'
    )).filter(visible);
    const labels = (element) => [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
      ...Array.from(element.querySelectorAll('*')).flatMap((child) => [
        child.getAttribute('aria-label'),
        child.getAttribute('title'),
        child.textContent,
      ]),
    ].filter(Boolean).map(normalize);
    let matches = expected
      ? candidates.filter((element) => labels(element).some((label) => label === expected))
      : [];
    if (matches.length === 0 && expected) {
      matches = candidates.filter((element) => normalize(element.textContent).startsWith(expected + ' '));
    }
    const modelOption = matches.length === 1 && matches[0] instanceof HTMLElement ? matches[0] : undefined;
    const modelOptionPoint = modelOption
      ? (() => {
          const rect = modelOption.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()
      : undefined;

    const sliderContainer = Array.from(root.querySelectorAll('[data-model-reasoning-effort-slider]')).filter(visible).at(-1);
    const sliderElement = sliderContainer?.querySelector('[role="slider"]');
    const integer = (value) => /^-?\\d+$/.test(String(value || '')) ? Number(value) : undefined;
    const min = sliderElement ? integer(sliderElement.getAttribute('aria-valuemin')) : undefined;
    const max = sliderElement ? integer(sliderElement.getAttribute('aria-valuemax')) : undefined;
    const value = sliderElement ? integer(sliderElement.getAttribute('aria-valuenow')) : undefined;
    const slider = Number.isSafeInteger(min) && Number.isSafeInteger(max) && Number.isSafeInteger(value)
      && max >= min && value >= min && value <= max && (max - min + 1) <= 5
      ? {
          min,
          max,
          value,
          valueText: String(sliderElement.getAttribute('aria-valuetext') || '').trim() || undefined,
        }
      : undefined;

    return {
      menuOpen: true,
      selectedModel,
      modelSelected: Boolean(expected && selectedModel && normalize(selectedModel) === expected),
      modelOptionCount: matches.length,
      modelOptionPoint,
      slider,
    };
  })()`;
}

function executionSliderPointExpression(targetValue: number): string {
  return `(() => {
    /* C2C_EXECUTION_SLIDER_POINT */
    const target = ${targetValue};
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const containers = Array.from(document.querySelectorAll('[data-model-reasoning-effort-slider]')).filter(visible);
    if (containers.length !== 1) return null;
    const container = containers[0];
    const slider = container.querySelector('[role="slider"]');
    if (!(slider instanceof HTMLElement)) return null;
    const min = Number(slider.getAttribute('aria-valuemin'));
    const max = Number(slider.getAttribute('aria-valuemax'));
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min || target < min || target > max) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ratio = max === min ? 0.5 : (target - min) / (max - min);
    return { x: rect.left + Math.max(0, Math.min(1, ratio)) * rect.width, y: rect.top + rect.height / 2 };
  })()`;
}

async function evaluateValue<T>(connection: CdpConnection, expression: string): Promise<T | undefined> {
  const evaluated = await connection.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return resultValue(evaluated) as T | undefined;
}

async function clickPoint(connection: CdpConnection, point: Point): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await connection.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
}

async function closeExecutionMenu(connection: CdpConnection): Promise<void> {
  const surface = await evaluateValue<ExecutionSurface>(connection, executionSurfaceExpression()).catch(() => undefined);
  if (!surface?.menuOpen) return;
  for (const type of ["keyDown", "keyUp"] as const) {
    await connection.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    }).catch(() => undefined);
  }
}

async function openExecutionMenu(
  connection: CdpConnection,
  sleepMs: (ms: number) => Promise<void>,
): Promise<ExecutionSurface> {
  let surface = await evaluateValue<ExecutionSurface>(connection, executionSurfaceExpression());
  if (surface?.menuOpen) return surface;

  const point = await evaluateValue<Point | null>(connection, executionControlExpression());
  if (!point) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      "ChatGPT execution controls are unavailable: no unique model/reasoning composer control was found",
    );
  }
  await clickPoint(connection, point);
  for (let attempt = 0; attempt < EXECUTION_MENU_ATTEMPTS; attempt += 1) {
    await sleepMs(EXECUTION_MENU_POLL_MS);
    surface = await evaluateValue<ExecutionSurface>(connection, executionSurfaceExpression());
    if (surface?.menuOpen) return surface;
  }
  throw new DomainError(
    ErrorCode.WORKSPACE_NOT_READY,
    "ChatGPT execution controls did not expose the model/reasoning menu after activation",
  );
}

async function ensureModel(
  connection: CdpConnection,
  targetModel: string,
  sleepMs: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  await openExecutionMenu(connection, sleepMs);
  let surface = await evaluateValue<ExecutionSurface>(connection, executionSurfaceExpression(targetModel));
  if (surface?.modelSelected || labelsMatch(surface?.selectedModel, targetModel)) return surface?.selectedModel;
  if (!surface?.modelOptionPoint || surface.modelOptionCount !== 1) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `ChatGPT model option "${targetModel}" is unavailable or ambiguous in the current execution picker`,
    );
  }

  await clickPoint(connection, surface.modelOptionPoint);
  await sleepMs(EXECUTION_VERIFY_POLL_MS);
  await openExecutionMenu(connection, sleepMs);
  for (let attempt = 0; attempt < EXECUTION_VERIFY_ATTEMPTS; attempt += 1) {
    surface = await evaluateValue<ExecutionSurface>(connection, executionSurfaceExpression(targetModel));
    if (surface?.modelSelected || labelsMatch(surface?.selectedModel, targetModel)) return surface?.selectedModel;
    await sleepMs(EXECUTION_VERIFY_POLL_MS);
  }
  throw new DomainError(
    ErrorCode.WORKSPACE_NOT_READY,
    `ChatGPT model selection did not verify as "${targetModel}" after the picker interaction`,
  );
}

async function ensureReasoning(
  connection: CdpConnection,
  effort: WorkerReasoningEffort,
  sleepMs: (ms: number) => Promise<void>,
): Promise<WorkerReasoningEffort> {
  let surface = await openExecutionMenu(connection, sleepMs);
  const slider = surface.slider;
  if (!slider) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `ChatGPT reasoning effort "${effort}" cannot be verified because the execution picker exposes no structural effort slider`,
    );
  }
  const targetValue = slider.min + effortOffset(effort);
  if (targetValue > slider.max) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `ChatGPT reasoning effort "${effort}" is unavailable in the current account/profile`,
    );
  }
  if (slider.value === targetValue) return effort;

  const point = await evaluateValue<Point | null>(connection, executionSliderPointExpression(targetValue));
  if (!point) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `ChatGPT reasoning effort "${effort}" could not be targeted in the current execution slider`,
    );
  }
  await clickPoint(connection, point);
  for (let attempt = 0; attempt < EXECUTION_VERIFY_ATTEMPTS; attempt += 1) {
    await sleepMs(EXECUTION_VERIFY_POLL_MS);
    const observed = await evaluateValue<ExecutionSurface>(connection, executionSurfaceExpression());
    surface = observed?.menuOpen ? observed : await openExecutionMenu(connection, sleepMs);
    if (surface.slider?.value === targetValue) return effort;
  }
  throw new DomainError(
    ErrorCode.WORKSPACE_NOT_READY,
    `ChatGPT reasoning effort did not verify as "${effort}" after the picker interaction`,
  );
}

function explicitExecutionRequested(intent: WorkerExecutionIntent | undefined): boolean {
  return Boolean(intent?.resolved?.model || intent?.resolved?.reasoningEffort);
}

function executionDiagnostic(
  surface: ExecutionSurface | undefined,
  message: string,
): WorkerExecutionApplyResult {
  return {
    verified: false,
    ...(surface?.selectedModel ? { observedModel: surface.selectedModel } : {}),
    ...(effortForSliderValue(surface?.slider)
      ? { observedReasoningEffort: effortForSliderValue(surface?.slider) }
      : {}),
    error: message,
  };
}

/**
 * Apply a durable worker execution intent to the current ChatGPT composer before
 * the Worker app is selected or any bootstrap text is inserted. The adapter
 * relies on current structural UI signals (unified intelligence picker + ARIA
 * effort slider) and verifies post-interaction state instead of treating clicks
 * as success. `allow-current` is the only policy that may continue unverified.
 */
export async function applyWorkerExecutionIntent(
  connection: CdpConnection,
  intent: WorkerExecutionIntent | undefined,
  sleepMs: (ms: number) => Promise<void>,
): Promise<WorkerExecutionApplyResult> {
  if (!explicitExecutionRequested(intent)) return { verified: true };

  const resolved = intent?.resolved;
  try {
    const observedModel = resolved?.model
      ? await ensureModel(connection, resolved.model, sleepMs)
      : undefined;
    const observedReasoningEffort = resolved?.reasoningEffort
      ? await ensureReasoning(connection, resolved.reasoningEffort, sleepMs)
      : undefined;
    await closeExecutionMenu(connection);
    return {
      verified: true,
      ...(observedModel ? { observedModel } : {}),
      ...(observedReasoningEffort ? { observedReasoningEffort } : {}),
    };
  } catch (error) {
    const surface = await evaluateValue<ExecutionSurface>(
      connection,
      executionSurfaceExpression(),
    ).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = executionDiagnostic(surface, message);
    await closeExecutionMenu(connection).catch(() => undefined);
    if (resolved?.fallbackPolicy === "allow-current") {
      return diagnostic;
    }
    if (error instanceof DomainError) {
      throw new DomainError(error.code, error.message, {
        ...(error.details ?? {}),
        workerExecution: diagnostic,
      });
    }
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `ChatGPT execution settings could not be verified: ${message}`,
      { workerExecution: diagnostic },
    );
  }
}
