export type PonytailMode = "lite" | "full" | "ultra" | "off";

export const DEFAULT_PONYTAIL_MODE: PonytailMode = "full";

const DIRECTIVE_RE = /^\/?ponytail\s+(lite|full|ultra|off)\s*$/i;

export interface PonytailTask {
  mode: PonytailMode;
  task: string;
}

function normalizeMode(value: string): PonytailMode {
  return value.toLowerCase() as PonytailMode;
}

/**
 * Resolve an optional task-local Ponytail directive. Only the first non-empty
 * line is treated as a directive so ordinary task prose is never rewritten by
 * an incidental later mention of "ponytail".
 */
export function resolvePonytailTask(
  rawTask: string,
  defaultMode: PonytailMode = DEFAULT_PONYTAIL_MODE,
): PonytailTask {
  const lines = rawTask.replace(/\r\n/g, "\n").split("\n");
  const firstMeaningful = lines.findIndex((line) => line.trim().length > 0);
  if (firstMeaningful < 0) return { mode: defaultMode, task: "" };

  const match = lines[firstMeaningful]!.trim().match(DIRECTIVE_RE);
  if (!match) return { mode: defaultMode, task: rawTask.trim() };

  const task = [...lines.slice(0, firstMeaningful), ...lines.slice(firstMeaningful + 1)]
    .join("\n")
    .trim();
  return { mode: normalizeMode(match[1]!), task };
}

function sharedPolicy(): string[] {
  return [
    "Be lazy in the engineering sense: minimize unnecessary code and ownership while remaining correct.",
    "Understand the affected flow before editing; fix bugs at the narrowest common point that actually owns the problem.",
    "Before adding code, prefer in order: no new functionality, existing repository code, standard library, native platform/framework behavior, already-installed dependencies, a direct local expression, then the minimum new code required.",
    "Avoid speculative abstractions, one-use factories/interfaces/configuration, unrelated refactors, and new helpers that only rename an existing operation.",
    "Prefer deletion, reuse, boring obvious code, and the shortest coherent diff when those choices still solve the real problem.",
    "Do not simplify away trust-boundary validation, data-loss/corruption safeguards, required error handling, security controls, accessibility fundamentals, meaningful edge cases, or behavior explicitly requested by the user.",
    "For non-trivial new logic, add the smallest useful runnable check in the repository's existing test style; trivial one-line changes do not automatically require a new test.",
    "If a deliberate shortcut has a real future ceiling, leave a short `ponytail:` comment stating the limitation and the concrete condition that would justify upgrading it; do not add such comments to trivial design choices.",
    "Project instructions and the user's explicit task requirements take precedence over this engineering policy.",
  ];
}

export function buildPonytailPolicy(mode: PonytailMode): string {
  if (mode === "off") return "";

  const modeRules: Record<Exclude<PonytailMode, "off">, string[]> = {
    lite: [
      "LITE mode: implement the requested solution normally. If there is a materially simpler alternative, mention it briefly, but do not silently substitute a different scope for what the user asked.",
    ],
    full: [
      "FULL mode (default): enforce the reuse/native/direct-expression ladder, prefer the minimum coherent implementation, and do not add speculative infrastructure.",
    ],
    ultra: [
      "ULTRA mode: apply YAGNI aggressively. Look for deletion or no-code solutions before addition, and challenge speculative requirements, while still completing the useful requested work rather than stalling.",
    ],
  };

  return [
    `Ponytail coding policy (${mode.toUpperCase()}):`,
    ...sharedPolicy().map((line) => `- ${line}`),
    ...modeRules[mode].map((line) => `- ${line}`),
  ].join("\n");
}

/**
 * Apply Ponytail only to the worker task text handed to ChatGPT Web. Durable
 * worker state keeps the original task unchanged, so policy adaptation remains
 * an instruction-layer concern and never becomes worker-state authority.
 */
export function applyPonytailToWorkerTask(
  rawTask: string,
  defaultMode: PonytailMode = DEFAULT_PONYTAIL_MODE,
): string {
  const resolved = resolvePonytailTask(rawTask, defaultMode);
  if (resolved.mode === "off") return resolved.task;
  const policy = buildPonytailPolicy(resolved.mode);
  return resolved.task ? `${policy}\n\nAssigned coding task:\n${resolved.task}` : policy;
}
