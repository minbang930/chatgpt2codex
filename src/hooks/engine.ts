import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildSafeChildEnv } from "../exec/command-runner.js";

export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookCommandCwd = "project" | "workspace" | "state";
export type HookRunStatus = "ok" | "failed" | "timed_out";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_HOOKS_PER_EVENT = 20;

const hookCommandSchema = z
  .object({
    id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/),
    type: z.literal("command"),
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64).optional().default([]),
    cwd: z.enum(["project", "workspace", "state"]).optional().default("workspace"),
    timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional().default(DEFAULT_TIMEOUT_MS),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

const hookListSchema = z.array(hookCommandSchema).max(MAX_HOOKS_PER_EVENT);

const hooksByEventSchema = z
  .object({
    SessionStart: hookListSchema.optional(),
    PreToolUse: hookListSchema.optional(),
    PostToolUse: hookListSchema.optional(),
    SubagentStart: hookListSchema.optional(),
    SubagentStop: hookListSchema.optional(),
  })
  .strict();

const hookConfigSchema = z
  .object({
    version: z.literal(1),
    hooks: hooksByEventSchema.optional().default({}),
  })
  .strict();

export type HookCommandDefinition = z.infer<typeof hookCommandSchema>;
export type HookConfig = z.infer<typeof hookConfigSchema>;

export interface HookEmitContext {
  workspaceRoot: string;
  projectRoot?: string;
}

export interface HookRunResult {
  id: string;
  status: HookRunStatus;
  exitCode: number | null;
  durationMs: number;
  cwd: string;
  stdoutSummary: string;
  stderrSummary: string;
  outputTruncated: boolean;
  error?: string;
}

export interface HookDispatchReport {
  event: HookEvent;
  configPath: string;
  configured: number;
  executed: number;
  durationMs: number;
  configError?: string;
  results: HookRunResult[];
}

interface LoadedHookConfig {
  configPath: string;
  config?: HookConfig;
  error?: string;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");
}

export async function loadHookConfig(stateDir: string): Promise<LoadedHookConfig> {
  const configPath = path.join(stateDir, "hooks.json");
  let raw: string;
  try {
    const stat = await fs.stat(configPath);
    if (stat.size > MAX_CONFIG_BYTES) {
      return { configPath, error: `hook config exceeds ${MAX_CONFIG_BYTES} bytes` };
    }
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configPath };
    return { configPath, error: `could not read hook config: ${(error as Error).message}` };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { configPath, error: `hook config is not valid JSON: ${(error as Error).message}` };
  }

  const parsed = hookConfigSchema.safeParse(parsedJson);
  if (!parsed.success) return { configPath, error: formatZodError(parsed.error) };
  return { configPath, config: parsed.data };
}

function resolveHookCwd(
  definition: HookCommandDefinition,
  context: HookEmitContext,
  stateDir: string,
): string {
  switch (definition.cwd) {
    case "project":
      return context.projectRoot ?? context.workspaceRoot;
    case "state":
      return stateDir;
    case "workspace":
    default:
      return context.workspaceRoot;
  }
}

function appendBounded(
  current: Buffer,
  chunk: Buffer,
): { value: Buffer; truncated: boolean } {
  if (current.length >= MAX_OUTPUT_BYTES) return { value: current, truncated: chunk.length > 0 };
  const remaining = MAX_OUTPUT_BYTES - current.length;
  if (chunk.length <= remaining) return { value: Buffer.concat([current, chunk]), truncated: false };
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    execFile(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true },
      () => undefined,
    );
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The hook may already have exited between timeout and termination.
  }
}

async function runCommandHook(
  definition: HookCommandDefinition,
  event: HookEvent,
  payload: Record<string, unknown>,
  context: HookEmitContext,
  stateDir: string,
): Promise<HookRunResult> {
  const cwd = resolveHookCwd(definition, context, stateDir);
  const startedAt = Date.now();
  const envelope = `${JSON.stringify({
    version: 1,
    event,
    hookId: definition.id,
    occurredAt: new Date().toISOString(),
    payload,
  })}\n`;

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (result: Omit<HookRunResult, "durationMs" | "cwd" | "id">) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        id: definition.id,
        cwd,
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(definition.command, definition.args, {
        cwd,
        env: buildSafeChildEnv(),
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        status: "failed",
        exitCode: null,
        stdoutSummary: "",
        stderrSummary: "",
        outputTruncated: false,
        error: (error as Error).message,
      });
      return;
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const next = appendBounded(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      stdout = next.value;
      outputTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const next = appendBounded(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      stderr = next.value;
      outputTruncated ||= next.truncated;
    });

    child.once("error", (error) => {
      finish({
        status: timedOut ? "timed_out" : "failed",
        exitCode: null,
        stdoutSummary: stdout.toString("utf8"),
        stderrSummary: stderr.toString("utf8"),
        outputTruncated,
        error: timedOut ? `hook timed out after ${definition.timeoutMs}ms` : error.message,
      });
    });

    child.once("close", (code) => {
      if (timedOut) {
        finish({
          status: "timed_out",
          exitCode: typeof code === "number" ? code : null,
          stdoutSummary: stdout.toString("utf8"),
          stderrSummary: stderr.toString("utf8"),
          outputTruncated,
          error: `hook timed out after ${definition.timeoutMs}ms`,
        });
        return;
      }
      const exitCode = typeof code === "number" ? code : null;
      finish({
        status: exitCode === 0 ? "ok" : "failed",
        exitCode,
        stdoutSummary: stdout.toString("utf8"),
        stderrSummary: stderr.toString("utf8"),
        outputTruncated,
        ...(exitCode === 0 ? {} : { error: `hook exited with code ${exitCode ?? "unknown"}` }),
      });
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, definition.timeoutMs);

    child.stdin.on("error", () => undefined);
    child.stdin.end(envelope);
  });
}

/**
 * M4 hook foundation.
 *
 * Configuration is deliberately read only from the runtime-owned stateDir.
 * Repository files are never auto-executed as hook configuration. Hook
 * commands receive a bounded JSON event envelope on stdin, run without a
 * shell, inherit only the existing safe child environment, and are always
 * best-effort: a malformed config or failing hook is reported but never
 * throws through the caller's normal Core path.
 */
export class HookEngine {
  constructor(private readonly stateDir: string) {}

  async emit(
    event: HookEvent,
    payload: Record<string, unknown>,
    context: HookEmitContext,
  ): Promise<HookDispatchReport> {
    const startedAt = Date.now();
    const loaded = await loadHookConfig(this.stateDir);
    if (!loaded.config) {
      return {
        event,
        configPath: loaded.configPath,
        configured: 0,
        executed: 0,
        durationMs: Date.now() - startedAt,
        ...(loaded.error ? { configError: loaded.error } : {}),
        results: [],
      };
    }

    const definitions = loaded.config.hooks[event] ?? [];
    const enabled = definitions.filter((definition) => definition.enabled);
    const results: HookRunResult[] = [];
    for (const definition of enabled) {
      results.push(await runCommandHook(definition, event, payload, context, this.stateDir));
    }

    return {
      event,
      configPath: loaded.configPath,
      configured: definitions.length,
      executed: results.length,
      durationMs: Date.now() - startedAt,
      results,
    };
  }
}
