import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKER_CORE_TOOL_NAMES, dispatchWorkerCoreTool } from "../agents/dispatcher.js";
import { registerPlugin } from "./registry.js";
import { createServer } from "../server/mcp-server.js";
import type { ToolContext } from "../types.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeCtx(): Promise<ToolContext> {
  const stateDir = await temp("chatgpt2codex-plugin-worker-isolation-");
  return {
    workspaceRoot: path.dirname(stateDir),
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: path.dirname(stateDir),
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
    remote: true,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin / browser-worker isolation boundary", () => {
  it("keeps configured plugin authority out of the worker-prefixed capability surface", async () => {
    const ctx = await makeCtx();
    await registerPlugin({
      stateDir: ctx.stateDir,
      id: "configured-plugin",
      name: "Configured Plugin",
      url: "http://127.0.0.1:9/mcp",
      enabled: true,
    });

    const server = await createServer(ctx);
    const tools = (server as unknown as {
      _registeredTools?: Record<string, { handler?: (input: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools ?? {};

    // Main-agent fixed proxy tools still exist when plugin configuration is present.
    expect(tools.plugin_list).toBeDefined();
    expect(tools.plugin_discover).toBeDefined();
    expect(tools.plugin_call).toBeDefined();

    const listed = await tools.plugin_list?.handler?.({}) as {
      structuredContent?: { plugins?: Array<{ id?: string; enabled?: boolean }>; total?: number };
      isError?: boolean;
    } | undefined;
    expect(listed?.isError).not.toBe(true);
    expect(listed?.structuredContent?.total).toBe(1);
    expect(listed?.structuredContent?.plugins?.[0]).toMatchObject({ id: "configured-plugin", enabled: true });

    // Browser-worker mirrors are generated only from the explicit Core allowlist.
    for (const coreName of WORKER_CORE_TOOL_NAMES) {
      expect(tools[`worker_${coreName}`], `worker_${coreName}`).toBeDefined();
    }
    expect(Object.keys(tools).filter((name) => name.startsWith("worker_plugin_"))).toEqual([]);

    // Even a caller holding a worker capability cannot route plugin tools through
    // the worker dispatcher: allowlist rejection happens before capability use.
    for (const pluginTool of ["plugin_list", "plugin_discover", "plugin_call"]) {
      await expect(dispatchWorkerCoreTool(ctx, "opaque-worker-token", pluginTool, {})).rejects.toThrow(/not allowed for workers/);
    }
  });

  it("documents that the shared remote catalog still lists the main-agent plugin proxies", async () => {
    const ctx = await makeCtx();
    await registerPlugin({
      stateDir: ctx.stateDir,
      id: "catalog-plugin",
      name: "Catalog Plugin",
      url: "http://127.0.0.1:9/mcp",
      enabled: true,
    });

    const server = await createServer(ctx);
    const handler = (server.server as unknown as {
      _requestHandlers?: Map<
        string,
        (request: { method: string; params: Record<string, never> }) => Promise<{ tools: Array<{ name: string }> }>
      >;
    })._requestHandlers?.get("tools/list");
    const listed = await handler?.({ method: "tools/list", params: {} });
    const names = listed?.tools.map((tool) => tool.name) ?? [];

    expect(names).toEqual(expect.arrayContaining(["plugin_list", "plugin_discover", "plugin_call"]));
    expect(names.some((name) => name.startsWith("worker_plugin_"))).toBe(false);
  });
});
