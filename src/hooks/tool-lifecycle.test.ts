import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { createServer } from "../server/mcp-server.js";

const roots: string[] = [];

async function makeFixture(): Promise<{
  root: string;
  stateDir: string;
  workspaceRoot: string;
  projectRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-tool-hooks-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  return { root, stateDir, workspaceRoot, projectRoot };
}

function makeContext(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  options: { remote?: boolean; activeProjectId?: string | null } = {},
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
    ledger: { append: async () => undefined },
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

async function writeHookConfig(
  stateDir: string,
  hooks: Record<string, Array<Record<string, unknown>>>,
): Promise<void> {
  await writeFile(path.join(stateDir, "hooks.json"), JSON.stringify({ version: 1, hooks }, null, 2), "utf8");
}

function registeredHandler(server: unknown, name: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const tools = (server as { _registeredTools?: Record<string, { handler?: (...args: unknown[]) => Promise<Record<string, unknown>> }> })
    ._registeredTools;
  const handler = tools?.[name]?.handler;
  if (!handler) throw new Error(`missing registered tool handler: ${name}`);
  return handler;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tool lifecycle hooks", () => {
  it("emits ordered bounded PreToolUse/PostToolUse metadata around a registered MCP tool", async () => {
    const fixture = await makeFixture();
    const marker = path.join(fixture.root, "events.jsonl");
    const script = path.join(fixture.root, "capture-hook.mjs");
    await writeFile(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const event = JSON.parse(input);",
        `  appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: event.event, payload: event.payload, cwd: process.cwd() }) + '\\n');`,
        "});",
      ].join("\n"),
      "utf8",
    );
    const hook = {
      id: "capture-tool-lifecycle",
      type: "command",
      command: process.execPath,
      args: [script],
      cwd: "project",
    };
    await writeHookConfig(fixture.stateDir, { PreToolUse: [hook], PostToolUse: [hook] });

    const server = await createServer(makeContext(fixture, { remote: true, activeProjectId: "project-1" }));
    const result = await registeredHandler(server, "agent_guide")({});

    expect(result.isError).not.toBe(true);
    const events = (await readFile(marker, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; payload: Record<string, unknown>; cwd: string });
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("PreToolUse");
    expect(events[0]?.payload).toEqual({
      toolName: "agent_guide",
      remote: true,
      hasActiveProject: true,
      activeProjectId: "project-1",
    });
    expect(events[1]?.event).toBe("PostToolUse");
    expect(events[1]?.payload).toEqual(
      expect.objectContaining({
        toolName: "agent_guide",
        remote: true,
        hasActiveProject: true,
        activeProjectId: "project-1",
        success: true,
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("toolAvailabilityGate");
    expect(await realpath(events[0]?.cwd ?? "")).toBe(await realpath(fixture.projectRoot));
  });

  it("marks mapped tool errors unsuccessful and exposes only bounded requested project identity", async () => {
    const fixture = await makeFixture();
    const marker = path.join(fixture.root, "events.jsonl");
    const script = path.join(fixture.root, "capture-hook.mjs");
    await writeFile(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        "let input = ''; process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { const e = JSON.parse(input);",
        `  appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ event: e.event, payload: e.payload }) + '\\n'); });`,
      ].join("\n"),
      "utf8",
    );
    const hook = { id: "capture-error", type: "command", command: process.execPath, args: [script] };
    await writeHookConfig(fixture.stateDir, { PreToolUse: [hook], PostToolUse: [hook] });

    const server = await createServer(makeContext(fixture));
    const result = await registeredHandler(server, "project_status")({
      projectId: "missing-project",
      secret: "must-not-reach-hook",
    });

    expect(result.isError).toBe(true);
    const events = (await readFile(marker, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; payload: Record<string, unknown> });
    expect(events[0]?.payload.requestedProjectId).toBe("missing-project");
    expect(events[1]?.payload).toEqual(
      expect.objectContaining({ requestedProjectId: "missing-project", success: false }),
    );
    expect(JSON.stringify(events)).not.toContain("must-not-reach-hook");
  });

  it("does not let failing lifecycle hooks veto a healthy MCP tool", async () => {
    const fixture = await makeFixture();
    const failing = {
      id: "fails",
      type: "command",
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    };
    await writeHookConfig(fixture.stateDir, { PreToolUse: [failing], PostToolUse: [failing] });

    const server = await createServer(makeContext(fixture));
    const result = await registeredHandler(server, "agent_guide")({});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
  });
});
