import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCuaDriverCommand } from "../control/cua-driver-command.js";
import {
  getCuaDriverDiagnostics,
  probeCuaExactWindowObservations,
  resetCuaDriverDiagnostics,
  stopCuaDriver,
} from "../control/cua-driver.js";

interface Arguments {
  iterations: number;
  output: string;
}

interface LaunchedApp {
  name: string;
  titleNeedle: string;
  child: ChildProcess;
  cleanup: () => Promise<void>;
}

interface CompatResult {
  app: string;
  status: "ok" | "failed" | "skipped";
  reason?: string;
  target?: unknown;
  samples?: number;
  medianMs?: number;
  p95Ms?: number;
  minElements?: number;
  screenshotsOk?: boolean;
  getWindowState?: unknown;
  error?: string;
}

function parseArgs(argv: string[]): Arguments {
  const args: Arguments = {
    iterations: 5,
    output: path.resolve(
      ".chatgpt2codex",
      "benchmarks",
      `cua-real-app-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--iterations") args.iterations = Number(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1 || args.iterations > 20) {
    throw new Error("--iterations must be an integer from 1 to 20");
  }
  return args;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]! * 100) / 100;
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

function taskkillTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return Promise.resolve();
  return runProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
}

function resolveEdgePath(): string | undefined {
  const candidates = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ]
    .filter((value): value is string => Boolean(value))
    .map((root) =>
      root === process.env.LOCALAPPDATA
        ? path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")
        : path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  return candidates.find((candidate) => existsSync(candidate));
}

async function launchNotepad(tempRoot: string, unique: string): Promise<LaunchedApp> {
  const file = path.join(tempRoot, `ChatGPT2Codex-Cua-Compat-${unique}.txt`);
  await fs.writeFile(file, "chatgpt2codex cua exact-window compatibility probe\n", "utf8");
  const child = spawn("notepad.exe", [file], { windowsHide: false, stdio: "ignore" });
  return {
    name: "notepad",
    titleNeedle: path.basename(file),
    child,
    cleanup: async () => {
      if (child.pid && child.exitCode === null) await taskkillTree(child);
    },
  };
}

async function launchEdge(tempRoot: string, unique: string): Promise<LaunchedApp | undefined> {
  const edge = resolveEdgePath();
  if (!edge) return undefined;
  const title = `ChatGPT2Codex Cua Compat Edge ${unique}`;
  const html = path.join(tempRoot, `cua-edge-${unique}.html`);
  const profile = path.join(tempRoot, "edge-profile");
  await fs.writeFile(
    html,
    `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>`,
    "utf8",
  );
  const child = spawn(
    edge,
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      pathToFileURL(html).href,
    ],
    { windowsHide: false, stdio: "ignore" },
  );
  return {
    name: "edge",
    titleNeedle: title,
    child,
    cleanup: () => taskkillTree(child),
  };
}

async function main(args: Arguments): Promise<void> {
  if (process.platform !== "win32") throw new Error("Real-app Cua compatibility benchmark requires Windows");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-cua-real-"));
  const unique = `${process.pid}-${Date.now()}`;
  const launches: Array<LaunchedApp | undefined> = [
    await launchNotepad(tempRoot, unique),
    await launchEdge(tempRoot, unique),
  ];
  const results: CompatResult[] = [];

  try {
    for (const launched of launches) {
      if (!launched) {
        results.push({ app: "edge", status: "skipped", reason: "Microsoft Edge executable not found" });
        continue;
      }

      try {
        // Warm the Driver connection, process metadata and app itself. The
        // measured probe below resolves the exact titled window again.
        await probeCuaExactWindowObservations(launched.titleNeedle, tempRoot, 1, 20_000);
        resetCuaDriverDiagnostics();

        const probe = await probeCuaExactWindowObservations(
          launched.titleNeedle,
          tempRoot,
          args.iterations,
          10_000,
        );
        const screenshotChecks = await Promise.all(
          probe.samples.map(async (sample) => {
            const stat = await fs.stat(sample.screenshotPath).catch(() => undefined);
            return Boolean(stat?.isFile() && stat.size > 0);
          }),
        );
        const diagnostics = getCuaDriverDiagnostics();
        const times = probe.samples.map((sample) => sample.elapsedMs);
        const minElements = Math.min(...probe.samples.map((sample) => sample.elementCount));

        results.push({
          app: launched.name,
          status: screenshotChecks.every(Boolean) && minElements > 0 ? "ok" : "failed",
          target: probe.target,
          samples: probe.samples.length,
          medianMs: percentile(times, 0.5),
          p95Ms: percentile(times, 0.95),
          minElements,
          screenshotsOk: screenshotChecks.every(Boolean),
          getWindowState: diagnostics.toolTimings.get_window_state ?? null,
        });
      } catch (error) {
        results.push({
          app: launched.name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await launched.cleanup();
      }
    }

    const report = {
      schema: "chatgpt2codex.cua-real-app-compat/v1",
      createdAt: new Date().toISOString(),
      driver: resolveCuaDriverCommand(),
      iterations: args.iterations,
      results,
    };
    await fs.mkdir(path.dirname(args.output), { recursive: true });
    await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    process.stdout.write("# Cua real-app exact-window compatibility\n\n");
    process.stdout.write("| App | Status | Median | P95 | Min elements | Screenshots |\n");
    process.stdout.write("|---|---|---:|---:|---:|---:|\n");
    for (const result of results) {
      process.stdout.write(
        `| ${result.app} | ${result.status} | ${result.medianMs ?? "-"}${result.medianMs ? " ms" : ""} | ${result.p95Ms ?? "-"}${result.p95Ms ? " ms" : ""} | ${result.minElements ?? "-"} | ${result.screenshotsOk ?? "-"} |\n`,
      );
      if (result.error) process.stdout.write(`\n**${result.app}:** ${result.error}\n`);
    }
    process.stdout.write(`\nJSON: ${args.output}\n`);
  } finally {
    await stopCuaDriver().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const args = parseArgs(process.argv.slice(2));
main(args).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
  },
);
