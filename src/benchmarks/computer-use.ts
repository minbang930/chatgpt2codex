import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { captureControlAppScreenshot } from "../control/capture.js";
import * as desktop from "../control/input-backend.js";
import * as legacyWin from "../control/win-native.js";
import { stopWindowsUiaHelper } from "../control/win-uia.js";
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

interface FixtureState {
  current: string;
  submitted: string | null;
}

interface RunResult {
  iteration: number;
  success: boolean;
  typeApplied: boolean;
  submitApplied: boolean;
  totalMs: number;
  observeMs: number;
  typeMs: number;
  reobserveMs: number;
  clickMs: number;
  verifyMs: number;
  elementCount: number;
  typeForegroundPreserved: boolean | null;
  clickForegroundPreserved: boolean | null;
  typeRoute?: "semantic" | "coordinate";
  clickRoute?: "semantic" | "coordinate";
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
    typeApplyRate: number;
    submitApplyRate: number;
    medianTotalMs: number;
    p95TotalMs: number;
    medianObserveMs: number;
    medianTypeMs: number;
    medianReobserveMs: number;
    medianClickMs: number;
    typeForegroundPreservedRate: number | null;
    clickForegroundPreservedRate: number | null;
    semanticTypeRate: number;
    semanticClickRate: number;
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
  return args;
}

function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProcess(command: string, args: string[], timeoutMs = 30_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out: ${command}`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Process exited ${code ?? "unknown"}: ${stderr.trim() || "no stderr"}`));
    });
  });
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.stat(file).then((stat) => stat.isFile()).catch(() => false)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for fixture state: ${file}`);
}

async function readState(file: string): Promise<FixtureState> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, "")) as FixtureState;
}

async function waitForState(
  file: string,
  predicate: (state: FixtureState) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(file).catch(() => ({ current: "", submitted: null }));
    if (predicate(state)) return true;
    await wait(40);
  }
  return false;
}

async function buildFixture(tempRoot: string): Promise<string> {
  const output = path.join(tempRoot, `chatgpt2codex-cu-fixture-${process.pid}.exe`);
  const script = path.resolve("scripts", "fixtures", "computer-use-benchmark.ps1");
  const source = path.resolve("scripts", "fixtures", "computer-use-benchmark.cs");
  await runProcess(
    powershellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-SourcePath",
      source,
      "-OutputPath",
      output,
    ],
    60_000,
  );
  return output;
}

async function launchFixture(exePath: string, statePath: string): Promise<ChildProcess> {
  const child = spawn(exePath, [statePath, TARGET_TITLE], { windowsHide: false, stdio: "ignore" });
  await waitForFile(statePath, 15_000);
  return child;
}

async function waitForTargetWindow(
  fixturePid: number,
  fixture?: ChildProcess,
): Promise<{ appName: string; processId: number }> {
  const deadline = Date.now() + 30_000;
  let lastPidWindows: Array<{ appName: string; title: string; visible: boolean; minimized: boolean }> = [];
  while (Date.now() < deadline) {
    if (fixture?.exitCode !== null && fixture?.exitCode !== undefined) {
      throw new Error(`Benchmark fixture exited before its window appeared (pid ${fixturePid}, exit ${fixture.exitCode})`);
    }
    const windows = await desktop.listVisibleWindows();
    lastPidWindows = windows
      .filter((window) => window.processId === fixturePid)
      .map((window) => ({
        appName: window.appName,
        title: window.title,
        visible: window.visible,
        minimized: window.minimized,
      }));
    const match = windows.find(
      (window) => window.processId === fixturePid && window.title.includes(TARGET_TITLE),
    );
    if (match) return { appName: match.appName, processId: match.processId };
    await wait(150);
  }
  const diagnostic = lastPidWindows.length
    ? ` Last windows for pid: ${JSON.stringify(lastPidWindows)}`
    : " No visible windows for that pid were reported.";
  throw new Error(`Benchmark fixture window did not appear for pid ${fixturePid}.${diagnostic}`);
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
  // resolveWindowPoint calls the legacy windowRect helper, which deliberately
  // activates the exact app before returning the rect. No click is emitted.
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

function rate(values: boolean[]): number {
  if (!values.length) return 0;
  return Math.round((values.filter(Boolean).length / values.length) * 10_000) / 100;
}

function preservationRate(values: Array<boolean | null>): number | null {
  const known = values.filter((value): value is boolean => value !== null);
  return known.length ? rate(known) : null;
}

function summarize(runs: RunResult[]): NonNullable<BackendResult["summary"]> {
  return {
    successRate: rate(runs.map((run) => run.success)),
    typeApplyRate: rate(runs.map((run) => run.typeApplied)),
    submitApplyRate: rate(runs.map((run) => run.submitApplied)),
    medianTotalMs: percentile(runs.map((run) => run.totalMs), 0.5),
    p95TotalMs: percentile(runs.map((run) => run.totalMs), 0.95),
    medianObserveMs: percentile(runs.map((run) => run.observeMs), 0.5),
    medianTypeMs: percentile(runs.map((run) => run.typeMs), 0.5),
    medianReobserveMs: percentile(runs.map((run) => run.reobserveMs), 0.5),
    medianClickMs: percentile(runs.map((run) => run.clickMs), 0.5),
    typeForegroundPreservedRate: preservationRate(runs.map((run) => run.typeForegroundPreserved)),
    clickForegroundPreservedRate: preservationRate(runs.map((run) => run.clickForegroundPreserved)),
    semanticTypeRate: rate(runs.map((run) => run.typeRoute === "semantic")),
    semanticClickRate: rate(runs.map((run) => run.clickRoute === "semantic")),
  };
}

function findTextbox(observation: Awaited<ReturnType<typeof desktop.snapshotSemanticElements>>) {
  return observation.elements.find(
    (element) =>
      /benchmarkinput/i.test(element.name ?? "") ||
      /benchmarkinput/i.test(element.automationId ?? ""),
  ) ?? observation.elements.find((element) => element.actions.includes("setValue"));
}

function findButton(observation: Awaited<ReturnType<typeof desktop.snapshotSemanticElements>>) {
  return observation.elements.find(
    (element) =>
      /submit|benchmarksubmit/i.test(element.name ?? "") ||
      /benchmarksubmit/i.test(element.automationId ?? ""),
  ) ?? observation.elements.find(
    (element) =>
      element.actions.includes("invoke") ||
      element.actions.includes("select"),
  );
}

function center(bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}

async function fixturePoint(
  appName: string,
  kind: "textbox" | "button",
): Promise<{ x: number; y: number }> {
  // Fixed fallback only for this deterministic fixture. Prefer observed
  // semantic-element bounds whenever the backend exposes them.
  return desktop.resolveWindowPoint(
    appName,
    kind === "textbox" ? 0.486 : 0.164,
    kind === "textbox" ? 0.41 : 0.63,
  );
}

async function writeBenchmarkToken(
  appName: string,
  element: Awaited<ReturnType<typeof desktop.snapshotSemanticElements>>["elements"][number] | undefined,
  token: string,
): Promise<"semantic" | "coordinate"> {
  if (element?.actions.includes("setValue")) {
    try {
      await desktop.setAxValue(appName, element.selector, token);
      return "semantic";
    } catch {
      // Match the real executor contract: if semantic actuation fails and a
      // coordinate target is available, use the coordinate path.
    }
  }
  const point = element?.bounds ? center(element.bounds) : await fixturePoint(appName, "textbox");
  await desktop.clickAtPoint(appName, point.x, point.y);
  await desktop.typeText(appName, token);
  return "coordinate";
}

async function submitBenchmark(
  appName: string,
  element: Awaited<ReturnType<typeof desktop.snapshotSemanticElements>>["elements"][number] | undefined,
): Promise<"semantic" | "coordinate"> {
  if (
    element &&
    (element.actions.includes("invoke") ||
      element.actions.includes("select") ||
      element.actions.includes("focus"))
  ) {
    try {
      await desktop.pressAxElement(appName, element.selector);
      return "semantic";
    } catch {
      // Same executor-style coordinate fallback as writeBenchmarkToken.
    }
  }
  const point = element?.bounds ? center(element.bounds) : await fixturePoint(appName, "button");
  await desktop.clickAtPoint(appName, point.x, point.y);
  return "coordinate";
}

function observationDiagnostic(
  observation: Awaited<ReturnType<typeof desktop.snapshotSemanticElements>>,
): string {
  return JSON.stringify(
    observation.elements.slice(0, 20).map((element) => ({
      role: element.role,
      name: element.name,
      automationId: element.automationId,
      className: element.className,
      actions: element.actions,
    })),
  );
}

async function observe(
  backend: WindowsBackendMode,
  iteration: number,
  phase: "before-type" | "before-click",
  projectRoot: string,
  appName: string,
) {
  const started = performance.now();
  await captureControlAppScreenshot(projectRoot, {
    appName,
    label: `benchmark-${backend}-${iteration}-${phase}`,
    waitMs: 0,
  });
  const observation = await desktop.snapshotSemanticElements(appName, {
    maxElements: 120,
    maxDepth: 8,
  });
  return {
    observation,
    elapsedMs: performance.now() - started,
  };
}

async function runOne(
  backend: WindowsBackendMode,
  iteration: number,
  fixturePid: number,
  fixture: ChildProcess,
  projectRoot: string,
  statePath: string,
  decoyAppName: string | undefined,
): Promise<RunResult> {
  process.env.CHATGPT2CODEX_WINDOWS_BACKEND = backend;
  const totalStarted = performance.now();
  try {
    const target = await waitForTargetWindow(fixturePid, fixture);

    const first = await observe(backend, iteration, "before-type", projectRoot, target.appName);
    const textbox = findTextbox(first.observation);

    const token = `${backend}-${iteration}-${Date.now()}`;
    const beforeType = await focusDecoy(decoyAppName);
    const typeStarted = performance.now();
    const typeRoute = await writeBenchmarkToken(target.appName, textbox, token);
    const typeMs = performance.now() - typeStarted;
    const afterType = await legacyWin.resolveFrontmostApp().catch(() => undefined);
    const typeForegroundPreserved =
      decoyAppName && beforeType && sameApp(beforeType, decoyAppName)
        ? sameApp(afterType, decoyAppName)
        : null;
    const typeApplied = await waitForState(statePath, (state) => state.current === token, 1_500);

    // Cua element tokens are snapshot-scoped and the Driver guidance is one
    // action per observation. Reobserve before the second semantic action.
    // Apply the same loop to legacy so latency comparisons stay symmetric.
    const second = await observe(backend, iteration, "before-click", projectRoot, target.appName);
    const button = findButton(second.observation);

    const beforeClick = await focusDecoy(decoyAppName);
    const clickStarted = performance.now();
    const clickRoute = await submitBenchmark(target.appName, button);
    const clickMs = performance.now() - clickStarted;
    const afterClick = await legacyWin.resolveFrontmostApp().catch(() => undefined);
    const clickForegroundPreserved =
      decoyAppName && beforeClick && sameApp(beforeClick, decoyAppName)
        ? sameApp(afterClick, decoyAppName)
        : null;

    const verifyStarted = performance.now();
    const submitApplied = await waitForState(statePath, (state) => state.submitted === token, 2_500);
    const verifyMs = performance.now() - verifyStarted;
    const success = typeApplied && submitApplied;

    return {
      iteration,
      success,
      typeApplied,
      submitApplied,
      totalMs: Math.round((performance.now() - totalStarted) * 100) / 100,
      observeMs: Math.round(first.elapsedMs * 100) / 100,
      typeMs: Math.round(typeMs * 100) / 100,
      reobserveMs: Math.round(second.elapsedMs * 100) / 100,
      clickMs: Math.round(clickMs * 100) / 100,
      verifyMs: Math.round(verifyMs * 100) / 100,
      elementCount: first.observation.elements.length,
      typeForegroundPreserved,
      clickForegroundPreserved,
      typeRoute,
      clickRoute,
    };
  } catch (error) {
    return {
      iteration,
      success: false,
      typeApplied: false,
      submitApplied: false,
      totalMs: Math.round((performance.now() - totalStarted) * 100) / 100,
      observeMs: 0,
      typeMs: 0,
      reobserveMs: 0,
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
    "| Backend | Status | Success | Type applied | Submit applied | Median total | P95 total | Observe | Type | Reobserve | Click | Type semantic | Click semantic | Type FG preserved | Click FG preserved | Cua confirmed/unverifiable/noop |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const result of results) {
    const s = result.summary;
    const d = result.diagnostics;
    lines.push(
      `| ${result.backend} | ${result.status} | ${s ? `${s.successRate}%` : "-"} | ${s ? `${s.typeApplyRate}%` : "-"} | ${s ? `${s.submitApplyRate}%` : "-"} | ${s ? `${s.medianTotalMs} ms` : "-"} | ${s ? `${s.p95TotalMs} ms` : "-"} | ${s ? `${s.medianObserveMs} ms` : "-"} | ${s ? `${s.medianTypeMs} ms` : "-"} | ${s ? `${s.medianReobserveMs} ms` : "-"} | ${s ? `${s.medianClickMs} ms` : "-"} | ${s ? `${s.semanticTypeRate}%` : "-"} | ${s ? `${s.semanticClickRate}%` : "-"} | ${s?.typeForegroundPreservedRate ?? "-"}${s?.typeForegroundPreservedRate !== null && s ? "%" : ""} | ${s?.clickForegroundPreservedRate ?? "-"}${s?.clickForegroundPreservedRate !== null && s ? "%" : ""} | ${d ? `${d.confirmedActions}/${d.unverifiableActions}/${d.suspectedNoops}` : "-"} |`,
    );
  }
  for (const result of results) {
    if (result.error) {
      lines.push("", `**${result.backend} unavailable:** ${result.error}`);
    }
    const failed = result.runs.filter((run) => run.error).slice(0, 3);
    for (const run of failed) lines.push("", `**${result.backend} run ${run.iteration}:** ${run.error}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(args: Arguments): Promise<void> {
  if (process.platform !== "win32") throw new Error("Computer Use A/B benchmark must run on interactive Windows");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-cu-bench-"));
  const projectRoot = path.join(tempRoot, "project");
  const statePath = path.join(tempRoot, "fixture-state.json");
  await fs.mkdir(projectRoot, { recursive: true });
  const fixtureExe = await buildFixture(tempRoot);
  const fixture = await launchFixture(fixtureExe, statePath);
  if (!fixture.pid) throw new Error("Benchmark fixture process did not expose a pid");
  const decoy = await launchDecoy();
  const results: BackendResult[] = [];

  try {
    for (const backend of args.backends) {
      process.env.CHATGPT2CODEX_WINDOWS_BACKEND = backend;
      if (backend === "cua") resetCuaDriverDiagnostics();

      const runs: RunResult[] = [];
      const warmup = await runOne(backend, 0, fixture.pid, fixture, projectRoot, statePath, decoy.appName);
      if (warmup.error || !warmup.success) {
        const warmupError =
          warmup.error ??
          `Warm-up task failed (typeApplied=${warmup.typeApplied}, submitApplied=${warmup.submitApplied}, typeRoute=${warmup.typeRoute ?? "none"}, clickRoute=${warmup.clickRoute ?? "none"})`;
        results.push({
          backend,
          status: "unavailable",
          error: warmupError,
          runs: [warmup],
          ...(backend === "cua" ? { diagnostics: getCuaDriverDiagnostics() } : {}),
        });
        continue;
      }

      for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
        runs.push(await runOne(backend, iteration, fixture.pid!, fixture, projectRoot, statePath, decoy.appName));
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
      schema: "chatgpt2codex.computer-use-benchmark/v2",
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
    fixture.unref();
    decoy.child.kill();
    decoy.child.unref();
    await Promise.all([
      stopCuaDriver(),
      legacyWin.stopWindowsInputHelper(),
      stopWindowsUiaHelper(),
    ]);
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
