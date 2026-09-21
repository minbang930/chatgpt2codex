import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCuaDriverCommand } from "../control/cua-driver-command.js";
import {
  probeCuaExplicitWindowObservation,
  resolveCuaExactWindowTarget,
  stopCuaDriver,
} from "../control/cua-driver.js";

interface Arguments {
  output: string;
}

interface FixtureState {
  pid: number;
  hwndA: number;
  hwndB: number;
  bMinimized: boolean;
  bClosed: boolean;
}

function parseArgs(argv: string[]): Arguments {
  const args: Arguments = {
    output: path.resolve(
      ".chatgpt2codex",
      "benchmarks",
      `cua-window-identity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") args.output = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${value}`);
  }
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

async function buildFixture(tempRoot: string): Promise<string> {
  const output = path.join(tempRoot, `cua-window-identity-${process.pid}.exe`);
  await runProcess(
    powershellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts", "fixtures", "computer-use-benchmark.ps1"),
      "-SourcePath",
      path.resolve("scripts", "fixtures", "cua-window-identity.cs"),
      "-OutputPath",
      output,
    ],
    60_000,
  );
  return output;
}

async function readState(file: string): Promise<FixtureState> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, "")) as FixtureState;
}

async function waitForState(
  file: string,
  predicate: (state: FixtureState) => boolean,
  timeoutMs = 15_000,
): Promise<FixtureState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(file).catch(() => undefined);
    if (state && predicate(state)) return state;
    await wait(100);
  }
  throw new Error(`Timed out waiting for fixture state: ${file}`);
}

async function writeCommand(file: string, command: string): Promise<void> {
  await fs.writeFile(file, command, "utf8");
  await wait(250);
}

async function screenshotOk(file: string): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => undefined);
  return Boolean(stat?.isFile() && stat.size > 0);
}

async function observe(
  pid: number,
  windowId: number,
  outputPath: string,
): Promise<{ ok: boolean; error?: string; windowTitle?: string; elementCount?: number; screenshotOk?: boolean }> {
  try {
    const result = await probeCuaExplicitWindowObservation({ pid, windowId }, outputPath);
    return {
      ok: Boolean(result.snapshotId) && result.elementCount > 0 && await screenshotOk(outputPath),
      ...(result.windowTitle ? { windowTitle: result.windowTitle } : {}),
      elementCount: result.elementCount,
      screenshotOk: await screenshotOk(outputPath),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(args: Arguments): Promise<void> {
  if (process.platform !== "win32") throw new Error("Cua window identity benchmark requires Windows");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-cua-identity-"));
  const statePath = path.join(tempRoot, "state.json");
  const commandPath = path.join(tempRoot, "command.txt");
  const titleBase = `ChatGPT2Codex Cua Identity ${process.pid}-${Date.now()}`;
  const exe = await buildFixture(tempRoot);
  const child: ChildProcess = spawn(exe, [statePath, commandPath, titleBase], {
    windowsHide: false,
    stdio: "ignore",
  });

  let report: Record<string, unknown> = {};
  try {
    const state = await waitForState(statePath, (row) => row.hwndA > 0 && row.hwndB > 0);
    const targetA = await resolveCuaExactWindowTarget(`${titleBase} A`, 15_000);
    const targetB = await resolveCuaExactWindowTarget(`${titleBase} B`, 15_000);

    const identityMatch =
      targetA.pid === state.pid &&
      targetB.pid === state.pid &&
      targetA.windowId === state.hwndA &&
      targetB.windowId === state.hwndB &&
      targetA.windowId !== targetB.windowId;

    const observeA = await observe(state.pid, state.hwndA, path.join(tempRoot, "a.png"));
    const observeB = await observe(state.pid, state.hwndB, path.join(tempRoot, "b.png"));
    const titlesMatch =
      observeA.windowTitle?.includes(`${titleBase} A`) === true &&
      observeB.windowTitle?.includes(`${titleBase} B`) === true;

    await writeCommand(commandPath, "activate-a");
    const backgroundB = await observe(state.pid, state.hwndB, path.join(tempRoot, "b-background.png"));

    await writeCommand(commandPath, "minimize-b");
    const minimizedState = await waitForState(statePath, (row) => row.bMinimized);
    const minimizedTarget = await resolveCuaExactWindowTarget(`${titleBase} B`, 10_000, { allowMinimized: true });
    const minimizedB = await observe(
      minimizedState.pid,
      minimizedState.hwndB,
      path.join(tempRoot, "b-minimized.png"),
    );

    const wrongPid = await observe(
      state.pid + 1,
      state.hwndA,
      path.join(tempRoot, "wrong-pid.png"),
    );
    const wrongPidRejected =
      !wrongPid.ok &&
      /belongs to pid/i.test(wrongPid.error ?? "") &&
      /not pid/i.test(wrongPid.error ?? "");

    await writeCommand(commandPath, "close-b");
    await waitForState(statePath, (row) => row.bClosed);
    await wait(250);
    const staleB = await observe(state.pid, state.hwndB, path.join(tempRoot, "stale-b.png"));
    const staleRejected =
      !staleB.ok &&
      /(No window with window_id|belongs to pid)/i.test(staleB.error ?? "");

    const corePass =
      identityMatch &&
      observeA.ok &&
      observeB.ok &&
      titlesMatch &&
      backgroundB.ok &&
      wrongPidRejected &&
      staleRejected;

    report = {
      schema: "chatgpt2codex.cua-window-identity/v1",
      createdAt: new Date().toISOString(),
      driver: resolveCuaDriverCommand(),
      status: corePass ? "ok" : "failed",
      identityMatch,
      titlesMatch,
      targetA,
      targetB,
      observeA,
      observeB,
      backgroundB,
      minimized: {
        target: minimizedTarget,
        observation: minimizedB,
      },
      wrongPid: {
        rejected: wrongPidRejected,
        result: wrongPid,
      },
      staleWindow: {
        rejected: staleRejected,
        result: staleB,
      },
    };
  } finally {
    await writeCommand(commandPath, "exit").catch(() => undefined);
    if (child.pid && child.exitCode === null) {
      await runProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]).catch(() => undefined);
    }
    await stopCuaDriver().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write("# Cua exact-window identity benchmark\n\n");
  process.stdout.write(`Status: ${report.status}\n`);
  process.stdout.write(`Identity match: ${report.identityMatch}\n`);
  process.stdout.write(`Titles match: ${report.titlesMatch}\n`);
  const bg = report.backgroundB as { ok?: boolean } | undefined;
  const min = report.minimized as { observation?: { ok?: boolean; error?: string } } | undefined;
  const wrong = report.wrongPid as { rejected?: boolean } | undefined;
  const stale = report.staleWindow as { rejected?: boolean } | undefined;
  process.stdout.write(`Background B observation: ${bg?.ok ?? false}\n`);
  process.stdout.write(`Minimized B observation: ${min?.observation?.ok ?? false}${min?.observation?.error ? ` (${min.observation.error})` : ""}\n`);
  process.stdout.write(`Wrong PID rejected: ${wrong?.rejected ?? false}\n`);
  const wrongResult = (wrong as { result?: { error?: string } } | undefined)?.result;
  if (wrongResult?.error) process.stdout.write(`Wrong PID diagnostic: ${wrongResult.error}\n`);
  process.stdout.write(`Stale HWND rejected: ${stale?.rejected ?? false}\n`);
  const staleResult = (stale as { result?: { error?: string } } | undefined)?.result;
  if (staleResult?.error) process.stdout.write(`Stale HWND diagnostic: ${staleResult.error}\n`);
  process.stdout.write(`JSON: ${args.output}\n`);
}

const parsed = parseArgs(process.argv.slice(2));
main(parsed).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
  },
);
