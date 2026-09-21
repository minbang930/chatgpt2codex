import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { captureControlAppScreenshot } from "../control/capture.js";
import * as desktop from "../control/input-backend.js";
import * as legacyWin from "../control/win-native.js";
import {
  getCuaDriverDiagnostics,
  resetCuaDriverDiagnostics,
  stopCuaDriver,
  type CuaDriverDiagnostics,
} from "../control/cua-driver.js";
import type { WindowsBackendMode } from "../control/windows-backend-mode.js";

interface Arguments {
  iterations: number;
  backends: WindowsBackendMode[];
  output: string;
}

interface RunResult {
  iteration: number;
  success: boolean;
  totalMs: number;
  observeMs: number;
  typeMs: number;
  clickMs: number;
  verifyMs: number;
  elementCount: number;
  typeForegroundPreserved: boolean | null;
  clickForegroundPreserved: boolean | null;
  error?: string;
}

interface BackendResult {
  backend: WindowsBackendMode;
  status: "ok" | "unavailable";
  error?: string;
  runs: RunResult[];
  diagnostics?: CuaDriverDiagnostics;
  summary?: {
    successRate: number;
    medianTotalMs: number;
    p95TotalMs: number;
    medianObserveMs: number;
    medianTypeMs: number;
    medianClickMs: number;
    typeForegroundPreservedRate: number | null;
    clickForegroundPreservedRate: number | null;
  };
}

const TARGET_TITLE = "ChatGPT2Codex Computer Use Benchmark";

function parseArgs(argv: string[]): Arguments {
  const args: Arguments = {
    iterations: 10,
    backends: ["legacy", "cua"],
    output: path.resolve(
      ".chatgpt2codex",
      "benchmarks",
      `computer-use-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--iterations") args.iterations = Number(argv[++index]);
    else if (value === "--backends") {
      const parsed = (argv[++index] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      if (parsed.some((item) => item !== "legacy" && item !== "cua")) throw new Error("--backends accepts legacy,cua");
      args.backends = parsed as WindowsBackendMode[];
    } else if (value === "--output") args.output = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1 || args.iterations > 100) {
    throw new Error("--iterations must be an integer from 1 to 100");
  }
  if (!args.backends.length) throw new Error("At least one backend is required");
  if (!args.output) throw new Error("--output requires a path");
  return args;
}

function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.stat(file).then((stat) => stat.isFile()).catch(() => false)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for fixture state: ${file}`);
}

async function readState(file: string): Promise<{ submitted: string | null }> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, "")) as { submitted: string | null };
}

async function waitForSubmission(file: string, expected: string): Promise<boolean> {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    const state = await readState(file).catch(() => ({ submitted: null }));
    if (state.submitted === expected) return true;
    await wait(50);
  }
  return false;
}

async function waitForTargetWindow(): Promise<{ appName: string; processId: number }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const windows = await desktop.listVisibleWindows();
    const match = windows.find((window) => window.title.includes(TARGET_TITLE));
    if (match) {
      const sameApp = windows.filter((window) => window.appName.toLowerCase() === match.appName.toLowerCase());
      if (sameApp.length > 1) {
        throw new Error(
          `Benchmark fixture app identity "${match.appName}" is ambiguous (${sameApp.length} windows). Close other windows from that executable and retry.`,
        );
      }
      return { appName: match.appName, processId: match.processId };
    }
    await wait(200);
  }
  throw new Error("Benchmark fixture window did not appear");
}

async function launchFixture(statePath: string): Promise<ChildProcess> {
  const script = path.resolve("scripts", "fixtures", "computer-use-benchmark.ps1");
  const child = spawn(
    powershellPath(),
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-StatePath", statePath, "-Title", TARGET_TITLE],
    { windowsHide: false, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4000);
  });
  child.once("exit", (code) => {
    if (code && code !== 0) process.stderr.write(`benchmark fixture exited ${code}: ${stderr}\n`);
  });
  await waitForFile(statePath, 15_000);
  return child;
}

async function launchDecoy(): Promise<{ child: ChildProcess; appName?: string }> {
  const child = spawn("notepad.exe", [], { windowsHide: false, stdio: "ignore" });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const windows = await legacyWin.listVisibleWindows().catch(() => []);
    const byPid = child.pid ? windows.find((window) => window.processId === child.pid) : undefined;
    const match = byPid ?? windows.find((window) => /notepad/i.test(window.processName));
    if (match) return { child, appName: match.appName };
    await wait(200);
  }
  return { child };
}

async function focusDecoy(appName: string | undefined): Promise<string | undefined> {
  if (!appName) return undefined;
  await legacyWin.resolveWindowPoint(appName, 0.5, 0.5).catch(() => undefined);
  await wait(80);
  return legacyWin.resolveFrontmostApp().catch(() => undefined);
}

function sameApp(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().replace(/\.exe$/i, "").toLowerCase() === right.trim().replace(/\.exe$/i, "").toLowerCase();
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]! * 100) / 100;
}

function preservationRate(values: Array<boolean | null>): number | null {
  const known = values.filter((value): value is boolean => value !== null);
  if (!known.length) return null;
  return Math.round((known.filter(Boolean).length / known.length) * 10_000) / 100;
}

function summarize(runs: RunResult[]): NonNullable<BackendResult["summary"]> {
  const successful = runs.filter((run) => run.success);
  return {
    successRate: Math.round((successful.length / Math.max(1, runs.length)) * 10_000) / 100,
    medianTotalMs: percentile(runs.map((run) => run.totalMs), 0.5),
    p95TotalMs: percentile(runs.map((run) => run.totalMs), 0.95),
    medianObserveMs: percentile(runs.map((run) => run.observeMs), 0.5),
    medianTypeMs: percentile(runs.map((run) => run.typeMs), 0.5),
    medianClickMs: percentile(runs.map((run) => run.clickMs), 0.5),
    typeForegroundPreservedRate: preservationRate(runs.map((run) => run.typeForegroundPreserved)),
    clickForegroundPreservedRate: preservationRate(runs.map((run) => run.clickForegroundPreserved)),
  };
}

async function runOne(
  backend: WindowsBackendMode,
  iteration: number,
  projectRoot: string,
  statePath: string,
  decoyAppName: string | undefined,
): Promise<RunResult> {
  process.env.CHATGPT2CODEX_WINDOWS_BACKEND = backend;
  const totalStarted = performance.now();
  try {
    const target = await waitForTargetWindow();
    const observationStarted = performance.now();
    await captureControlAppScreenshot(projectRoot, {
      appName: target.appName,
      label: `benchmark-${backend}-${iteration}`,
      waitMs: 0,
    });
    const observation = await desktop.snapshotSemanticElements(target.appName, {
      maxElements: 120,
      maxDepth: 8,
    });
    const observeMs = performance.now() - observationStarted;

    const textbox =
      observation.elements.find(
        (element) => /benchmarkinput/i.test(element.name ?? "") && element.actions.includes("setValue"),
      ) ?? observation.elements.find((element) => element.actions.includes("setValue"));
    const button =
      observation.elements.find(
        (element) => /submit|benchmarksubmit/i.test(element.name ?? "") && element.actions.includes("invoke"),
      ) ??
      observation.elements.find(
        (element) => /submit|benchmarksubmit/i.test(element.name ?? "") && (element.actions.includes("select") || element.actions.includes("focus")),
      );
    if (!textbox) throw new Error("Benchmark textbox was not found in the semantic observation");
    if (!button) throw new Error("Benchmark Submit button was not found in the semantic observation");

    const token = `${backend}-${iteration}-${Date.now()}`;

    const beforeType = await focusDecoy(decoyAppName);
    const typeStarted = performance.now();
    await desktop.setAxValue(target.appName, textbox.selector, token);
    const typeMs = performance.now() - typeStarted;
    const afterType = await legacyWin.resolveFrontmostApp().catch(() => undefined);
    const typeForegroundPreserved =
      decoyAppName && beforeType && sameApp(beforeType, decoyAppName)
        ? sameApp(afterType, decoyAppName)
        : null;

    const beforeClick = await focusDecoy(decoyAppName);
    const clickStarted = performance.now();
    await desktop.pressAxElement(target.appName, button.selector);
    const clickMs = performance.now() - clickStarted;
    const afterClick = await legacyWin.resolveFrontmostApp().catch(() => undefined);
    const clickForegroundPreserved =
      decoyAppName && beforeClick && sameApp(beforeClick, decoyAppName)
        ? sameApp(afterClick, decoyAppName)
        : null;

    const verifyStarted = performance.now();
    const success = await waitForSubmission(statePath, token);
    const verifyMs = performance.now() - verifyStarted;

    return {
      iteration,
      success,
      totalMs: Math.round((performance.now() - totalStarted) * 100) / 100,
      observeMs: Math.round(observeMs * 100) / 100,
      typeMs: Math.round(typeMs * 100) / 100,
      clickMs: Math.round(clickMs * 100) / 100,
      verifyMs: Math.round(verifyMs * 100) / 100,
      elementCount: observation.elements.length,
      typeForegroundPreserved,
      clickForegroundPreserved,
    };
  } catch (error) {
    return {
      iteration,
      success: false,
      totalMs: Math.round((performance.now() - totalStarted) * 100) / 100,
      observeMs: 0,
      typeMs: 0,
      clickMs: 0,
      verifyMs: 0,
      elementCount: 0,
      typeForegroundPreserved: null,
      clickForegroundPreserved: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function markdown(results: BackendResult[]): string {
  const lines = [
    "# Computer Use A/B benchmark",
    "",
    "| Backend | Status | Success | Median total | P95 total | Median observe | Median type | Median click | Type foreground preserved | Click foreground preserved | Cua FG escalations |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const result of results) {
    const s = result.summary;
    lines.push(
      `| ${result.backend} | ${result.status} | ${s ? `${s.successRate}%` : "-"} | ${s ? `${s.medianTotalMs} ms` : "-"} | ${s ? `${s.p95TotalMs} ms` : "-"} | ${s ? `${s.medianObserveMs} ms` : "-"} | ${s ? `${s.medianTypeMs} ms` : "-"} | ${s ? `${s.medianClickMs} ms` : "-"} | ${s?.typeForegroundPreservedRate ?? "-"}${s?.typeForegroundPreservedRate !== null && s ? "%" : ""} | ${s?.clickForegroundPreservedRate ?? "-"}${s?.clickForegroundPreservedRate !== null && s ? "%" : ""} | ${result.diagnostics?.foregroundEscalations ?? "-"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(args: Arguments): Promise<void> {
  if (process.platform !== "win32") throw new Error("Computer Use A/B benchmark must run on interactive Windows");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-cu-bench-"));
  const projectRoot = path.join(tempRoot, "project");
  const statePath = path.join(tempRoot, "fixture-state.json");
  await fs.mkdir(projectRoot, { recursive: true });
  const fixture = await launchFixture(statePath);
  const decoy = await launchDecoy();
  const results: BackendResult[] = [];

  try {
    for (const backend of args.backends) {
      process.env.CHATGPT2CODEX_WINDOWS_BACKEND = backend;
      if (backend === "cua") resetCuaDriverDiagnostics();

      const runs: RunResult[] = [];
      // A warm-up is deliberately excluded from the report so helper/driver
      // process startup does not dominate steady-state A/B measurements.
      const warmup = await runOne(backend, 0, projectRoot, statePath, decoy.appName);
      if (!warmup.success && warmup.error) {
        results.push({
          backend,
          status: "unavailable",
          error: warmup.error,
          runs: [warmup],
          ...(backend === "cua" ? { diagnostics: getCuaDriverDiagnostics() } : {}),
        });
        continue;
      }

      for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
        runs.push(await runOne(backend, iteration, projectRoot, statePath, decoy.appName));
      }
      results.push({
        backend,
        status: "ok",
        runs,
        ...(backend === "cua" ? { diagnostics: getCuaDriverDiagnostics() } : {}),
        summary: summarize(runs),
      });
    }

    const report = {
      schema: "chatgpt2codex.computer-use-benchmark/v1",
      createdAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      iterations: args.iterations,
      cuaDriverBin: process.env.CUA_DRIVER_BIN ?? "cua-driver",
      results,
    };
    await fs.mkdir(path.dirname(args.output), { recursive: true });
    await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const mdPath = args.output.replace(/\.json$/i, ".md");
    await fs.writeFile(mdPath, markdown(results), "utf8");
    process.stdout.write(markdown(results));
    process.stdout.write(`JSON: ${args.output}\nMarkdown: ${mdPath}\n`);
  } finally {
    fixture.kill();
    decoy.child.kill();
    await stopCuaDriver();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  main(args).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
