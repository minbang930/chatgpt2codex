import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lease, ToolContext } from "../types.js";
import { registerWorkerExecutionSettingsTools } from "./worker-execution-settings-tools.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeCtx(preset: Lease["preset"] = "full-write"): Promise<ToolContext> {
  const stateDir = await temp("chatgpt2codex-worker-execution-tools-state-");
  const root = await temp("chatgpt2codex-worker-execution-tools-project-");
  const projectId = "project-execution-tools";
  const now = Date.now();
  const lease: Lease = {
    projectId,
    projectRoot: root,
    preset,
    leaseId: "lease_worker_execution_tools_test",
    issuedAt: now,
    expiresAt: now + 60_000,
  };
  const registry = [{ projectId, name: "execution-tools", root, aliases: ["execution-tools"] }];
  let session: unknown = { activeProjectId: projectId, mode: "edit", lease };

  return {
    workspaceRoot: path.dirname(root),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => session,
      setSession: async (next) => {
        session = next;
      },
    },
    config: {
      workspaceRoot: path.dirname(root),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function handlers(server: McpServer): Record<string, Handler> {
  return Object.fromEntries(
    Object.entries(
      (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {},
    ).flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

function serverWith(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "worker-execution-settings-tools-test", version: "1" });
  registerWorkerExecutionSettingsTools(server, ctx);
  return server;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker execution settings MCP tools", () => {
  it("reads an unconfigured global scope without requiring project mutation authority", async () => {
    const ctx = await makeCtx("read-only");
    const tool = handlers(serverWith(ctx));

    const result = await tool.worker_execution_settings_get?.({ scope: "global" });
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent).toMatchObject({
      scope: "global",
      configured: false,
    });
  });

  it("sets global and project defaults and exposes deterministic effective resolution", async () => {
    const ctx = await makeCtx("control");
    const tool = handlers(serverWith(ctx));

    const global = await tool.worker_execution_settings_set?.({
      scope: "global",
      model: " GPT-5.6 Sol ",
      fallbackPolicy: "allow-current",
    });
    expect(global?.isError).not.toBe(true);
    expect(global?.structuredContent).toMatchObject({
      scope: "global",
      configured: true,
      preference: { model: "GPT-5.6 Sol", fallbackPolicy: "allow-current" },
      effective: { model: "GPT-5.6 Sol", fallbackPolicy: "allow-current" },
    });

    const project = await tool.worker_execution_settings_set?.({
      scope: "project",
      reasoningEffort: "high",
    });
    expect(project?.isError).not.toBe(true);
    expect(project?.structuredContent).toMatchObject({
      scope: "project",
      projectId: "project-execution-tools",
      configured: true,
      preference: { reasoningEffort: "high" },
      effective: {
        model: "GPT-5.6 Sol",
        reasoningEffort: "high",
        fallbackPolicy: "allow-current",
      },
      sources: {
        model: "global",
        reasoningEffort: "project",
        fallbackPolicy: "global",
      },
    });
  });

  it("clears project settings without disturbing the global default", async () => {
    const ctx = await makeCtx();
    const tool = handlers(serverWith(ctx));

    await tool.worker_execution_settings_set?.({ scope: "global", reasoningEffort: "medium" });
    await tool.worker_execution_settings_set?.({ scope: "project", reasoningEffort: "high" });

    const cleared = await tool.worker_execution_settings_clear?.({ scope: "project" });
    expect(cleared?.isError).not.toBe(true);
    expect(cleared?.structuredContent).toMatchObject({
      scope: "project",
      configured: false,
      cleared: true,
      effective: {
        reasoningEffort: "medium",
        fallbackPolicy: "fail-closed",
      },
      sources: {
        reasoningEffort: "global",
        fallbackPolicy: "default",
      },
    });
  });

  it("requires existing worker orchestration authority for global and project mutations", async () => {
    const ctx = await makeCtx("read-only");
    const tool = handlers(serverWith(ctx));

    const global = await tool.worker_execution_settings_set?.({
      scope: "global",
      reasoningEffort: "medium",
    });
    expect(global?.isError).toBe(true);
    expect(global?.structuredContent).toMatchObject({ code: "PERMISSION_DENIED" });

    const project = await tool.worker_execution_settings_clear?.({ scope: "project" });
    expect(project?.isError).toBe(true);
    expect(project?.structuredContent).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("rejects an empty settings replacement", async () => {
    const ctx = await makeCtx();
    const tool = handlers(serverWith(ctx));

    const result = await tool.worker_execution_settings_set?.({ scope: "global" });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});
