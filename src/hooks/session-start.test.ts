import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { createServer } from "../server/mcp-server.js";
import { emitSessionStartHook } from "./session-start.js";

const roots: string[] = [];

async function makeFixture(): Promise<{
  root: string;
  stateDir: string;
  workspaceRoot: string;
  projectRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-session-hook-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  return { root, stateDir, workspaceRoot, projectRoot };
}

function makeContext(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  options: { remote?: boolean; activeProjectId?: string | null; onAudit?: (event: Record<string, unknown>) => void } = {},
): ToolContext {
  const project = {
    projectId: "project-1",
    name: "project",
    root: fixture.projectRoot,
    aliases: [],
  };
  return {
    workspaceRoot: fixture.workspaceRoot,
    stateDir: fixture.stateDir,
    registry: [project],
    ledger: {
      append: async (event) => {
        options.onAudit?.(event);
      },
    },
    store: {
      loadProjects: async () => [project],
      saveProjects: async () => undefined,
      getSession: async () => ({ activeProjectId: options.activeProjectId ?? null }),
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 60_000,
    },
    ...(options.remote === undefined ? {} : { remote: options.remote }),
  };
}

async function writeHookConfig(stateDir: string, hook: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(stateDir, "hooks.json"),
    JSON.stringify({ version: 1, hooks: { SessionStart: [hook] } }, null, 2),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionStart hooks", () => {
  it("emits bounded remote-session metadata and uses the active project as project cwd", async () => {
    const fixture = await makeFixture();
    const script = path.join(fixture.root, "session-hook.mjs");
    await writeFile(
      script,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const event = JSON.parse(input);",
        "  process.stdout.write(JSON.stringify({ payload: event.payload, cwd: process.cwd() }));",
        "});",
      ].join("\n"),
      "utf8",
    );
    await writeHookConfig(fixture.stateDir, {
      id: "session-capture",
      type: "command",
      command: process.execPath,
      args: [script],
      cwd: "project",
    });

    const audit: Record<string, unknown>[] = [];
    const report = await emitSessionStartHook(
      makeContext(fixture, { remote: true, activeProjectId: "project-1", onAudit: (event) => audit.push(event) }),
    );

    expect(report.executed).toBe(1);
    expect(report.results[0]?.status).toBe("ok");
    const output = JSON.parse(report.results[0]?.stdoutSummary ?? "{}") as {
      payload?: Record<string, unknown>;
      cwd?: string;
    };
    expect(output.payload).toEqual({
      transport: "http",
      remote: true,
      hasActiveProject: true,
      activeProjectId: "project-1",
    });
    expect(await realpath(output.cwd ?? "")).toBe(await realpath(fixture.projectRoot));
    expect(audit).toEqual([
      expect.objectContaining({
        type: "hook.dispatch",
        event: "SessionStart",
        configured: 1,
        executed: 1,
        failed: 0,
        timedOut: 0,
        configError: false,
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("stdoutSummary");
  });

  it("falls back to workspace context when persisted session state cannot be read", async () => {
    const fixture = await makeFixture();
    const script = path.join(fixture.root, "cwd-hook.mjs");
    await writeFile(
      script,
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.cwd()));\n",
      "utf8",
    );
    await writeHookConfig(fixture.stateDir, {
      id: "workspace-fallback",
      type: "command",
      command: process.execPath,
      args: [script],
      cwd: "project",
    });
    const ctx = makeContext(fixture);
    ctx.store.getSession = async () => {
      throw new Error("corrupt session");
    };

    const report = await emitSessionStartHook(ctx);

    expect(report.results[0]?.status).toBe("ok");
    expect(await realpath(report.results[0]?.stdoutSummary ?? "")).toBe(await realpath(fixture.workspaceRoot));
  });

  it("does not prevent MCP server creation when a SessionStart hook fails", async () => {
    const fixture = await makeFixture();
    const marker = path.join(fixture.root, "session-start-marker.txt");
    const script = path.join(fixture.root, "failing-hook.mjs");
    await writeFile(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(marker)}, 'started\\n');`,
        "process.exit(9);",
      ].join("\n"),
      "utf8",
    );
    await writeHookConfig(fixture.stateDir, {
      id: "fails-after-marker",
      type: "command",
      command: process.execPath,
      args: [script],
      timeoutMs: 2_000,
    });

    const server = await createServer(makeContext(fixture, { remote: false }));

    expect(server).toBeDefined();
    expect(await readFile(marker, "utf8")).toBe("started\n");
  });
});
