import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { registerPluginTools } from "./plugin-tools.js";

const dirs: string[] = [];

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "c2c-plugin-tools-"));
  dirs.push(dir);
  return dir;
}

function makeCtx(workspaceRoot: string, stateDir: string, remote = false): ToolContext {
  return {
    workspaceRoot,
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => undefined,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot,
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
    remote,
  };
}

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function handlers(server: McpServer): Record<string, Handler> {
  return Object.fromEntries(
    Object.entries((server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {})
      .flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external plugin management tools", () => {
  it("allows local registration and read-only listing", async () => {
    const workspace = await makeTemp();
    const stateDir = await makeTemp();
    const server = new McpServer({ name: "plugin-test", version: "1" });
    registerPluginTools(server, makeCtx(workspace, stateDir));
    const tool = handlers(server);

    const added = await tool.plugin_register?.({ id: "docs", name: "Docs", url: "https://example.org/mcp" });
    expect(added?.isError).not.toBe(true);
    expect(added?.structuredContent).toMatchObject({ plugin: { id: "docs", enabled: false } });

    const listed = await tool.plugin_list?.({});
    expect(listed?.structuredContent).toMatchObject({ total: 1, plugins: [expect.objectContaining({ id: "docs" })] });
  });

  it("refuses remote endpoint mutation", async () => {
    const workspace = await makeTemp();
    const stateDir = await makeTemp();
    const server = new McpServer({ name: "plugin-remote-test", version: "1" });
    registerPluginTools(server, makeCtx(workspace, stateDir, true));

    const result = await handlers(server).plugin_register?.({ id: "docs", name: "Docs", url: "https://example.org/mcp" });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
