import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookEngine, loadHookConfig } from "./engine.js";

const roots: string[] = [];

async function makeFixture(): Promise<{
  root: string;
  stateDir: string;
  workspaceRoot: string;
  projectRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-hooks-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  return { root, stateDir, workspaceRoot, projectRoot };
}

async function writeConfig(stateDir: string, value: unknown): Promise<void> {
  await writeFile(path.join(stateDir, "hooks.json"), JSON.stringify(value, null, 2), "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hooks/engine", () => {
  it("treats a missing hook config as a no-op", async () => {
    const fixture = await makeFixture();
    const engine = new HookEngine(fixture.stateDir);
    const report = await engine.emit("SessionStart", { session: "test" }, fixture);

    expect(report.configured).toBe(0);
    expect(report.executed).toBe(0);
    expect(report.configError).toBeUndefined();
    expect(report.results).toEqual([]);
  });

  it("reports invalid config without throwing through the caller", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.stateDir, "hooks.json"), "{ definitely not json", "utf8");

    const loaded = await loadHookConfig(fixture.stateDir);
    expect(loaded.config).toBeUndefined();
    expect(loaded.error).toMatch(/not valid JSON/i);

    const report = await new HookEngine(fixture.stateDir).emit("SessionStart", {}, fixture);
    expect(report.executed).toBe(0);
    expect(report.configError).toMatch(/not valid JSON/i);
  });

  it("runs a configured hook directly, feeds a JSON envelope on stdin, and honors project cwd", async () => {
    const fixture = await makeFixture();
    const script = path.join(fixture.root, "read-hook-input.mjs");
    await writeFile(
      script,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const event = JSON.parse(input);",
        "  process.stdout.write(JSON.stringify({ event: event.event, tool: event.payload.toolName, cwd: process.cwd() }));",
        "});",
      ].join("\n"),
      "utf8",
    );
    await writeConfig(fixture.stateDir, {
      version: 1,
      hooks: {
        PreToolUse: [
          {
            id: "capture-input",
            type: "command",
            command: process.execPath,
            args: [script],
            cwd: "project",
          },
        ],
      },
    });

    const report = await new HookEngine(fixture.stateDir).emit(
      "PreToolUse",
      { toolName: "file_read_slice" },
      fixture,
    );

    expect(report.configured).toBe(1);
    expect(report.executed).toBe(1);
    expect(report.results[0]?.status).toBe("ok");
    const output = JSON.parse(report.results[0]?.stdoutSummary ?? "{}") as {
      event?: string;
      tool?: string;
      cwd?: string;
    };
    expect(output.event).toBe("PreToolUse");
    expect(output.tool).toBe("file_read_slice");
    expect(path.resolve(output.cwd ?? "")).toBe(path.resolve(fixture.projectRoot));
  });

  it("isolates a failed hook and continues with later hooks", async () => {
    const fixture = await makeFixture();
    await writeConfig(fixture.stateDir, {
      version: 1,
      hooks: {
        PostToolUse: [
          {
            id: "fails",
            type: "command",
            command: process.execPath,
            args: ["-e", "process.exit(7)"],
          },
          {
            id: "still-runs",
            type: "command",
            command: process.execPath,
            args: ["-e", "process.stdout.write('after failure')"],
          },
        ],
      },
    });

    const report = await new HookEngine(fixture.stateDir).emit("PostToolUse", {}, fixture);

    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.exitCode).toBe(7);
    expect(report.results[1]?.status).toBe("ok");
    expect(report.results[1]?.stdoutSummary).toBe("after failure");
  });

  it("times out a wedged hook without rejecting the dispatch", async () => {
    const fixture = await makeFixture();
    await writeConfig(fixture.stateDir, {
      version: 1,
      hooks: {
        SubagentStart: [
          {
            id: "wedged",
            type: "command",
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 5000)"],
            timeoutMs: 100,
          },
        ],
      },
    });

    const report = await new HookEngine(fixture.stateDir).emit("SubagentStart", {}, fixture);

    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.status).toBe("timed_out");
    expect(report.results[0]?.error).toMatch(/timed out/i);
  });

  it("does not auto-execute repository hook files", async () => {
    const fixture = await makeFixture();
    const projectConfigDir = path.join(fixture.projectRoot, ".chatgpt2codex");
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      path.join(projectConfigDir, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          SessionStart: [
            {
              id: "repo-hook",
              type: "command",
              command: process.execPath,
              args: ["-e", "process.stdout.write('must not run')"],
            },
          ],
        },
      }),
      "utf8",
    );

    const report = await new HookEngine(fixture.stateDir).emit("SessionStart", {}, fixture);
    expect(report.configured).toBe(0);
    expect(report.executed).toBe(0);
  });
});
