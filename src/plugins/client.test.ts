import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callConfiguredPluginTool,
  discoverPlugin,
  MAX_PLUGIN_CALL_ARGUMENT_CHARS,
  type PluginCallDriver,
  type PluginDiscoveryDriver,
} from "./client.js";
import { registerPlugin, type PluginDefinition } from "./registry.js";

const tempDirs: string[] = [];

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "c2c-plugin-client-"));
  tempDirs.push(dir);
  return dir;
}

function plugin(enabled: boolean): PluginDefinition {
  return {
    id: "docs",
    name: "Docs MCP",
    enabled,
    transport: { kind: "streamable-http", url: "https://example.org/mcp", headers: [] },
    skillSources: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugins/client", () => {
  it("does not connect to disabled plugins", async () => {
    const discover = vi.fn();
    const driver: PluginDiscoveryDriver = { discover };
    const report = await discoverPlugin(plugin(false), { driver });
    expect(report.status).toBe("disabled");
    expect(discover).not.toHaveBeenCalled();
  });

  it("returns bounded tool metadata from an enabled plugin", async () => {
    const driver: PluginDiscoveryDriver = {
      discover: async () => ({
        server: { name: "docs-server", version: "1.0.0" },
        tools: [{ name: "lookup", description: "Look up docs", inputSchema: { type: "object" } }],
      }),
    };
    const report = await discoverPlugin(plugin(true), { driver });
    expect(report).toMatchObject({
      status: "ok",
      server: { name: "docs-server", version: "1.0.0" },
      totalTools: 1,
      truncated: false,
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    });
  });

  it("isolates discovery failures into the plugin report", async () => {
    const driver: PluginDiscoveryDriver = {
      discover: async () => {
        throw new Error("service unavailable");
      },
    };
    const report = await discoverPlugin(plugin(true), { driver });
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/service unavailable/i);
  });

  it("calls an explicitly enabled plugin through the fixed proxy driver", async () => {
    const stateDir = await temp();
    await registerPlugin({
      stateDir,
      id: "docs",
      name: "Docs MCP",
      url: "https://example.org/mcp",
      enabled: true,
    });
    const call = vi.fn(async () => ({ content: [{ type: "text", text: "matched" }] }));
    const driver: PluginCallDriver = { call };

    const report = await callConfiguredPluginTool({
      stateDir,
      pluginId: "docs",
      toolName: "lookup",
      arguments: { query: "alpha" },
      driver,
    });

    expect(report).toMatchObject({
      pluginId: "docs",
      toolName: "lookup",
      resultTruncated: false,
      result: { content: [{ type: "text", text: "matched" }] },
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it("refuses disabled plugins and oversized proxy arguments before the driver runs", async () => {
    const disabledState = await temp();
    await registerPlugin({ stateDir: disabledState, id: "docs", name: "Docs MCP", url: "https://example.org/mcp" });
    const call = vi.fn();
    const driver: PluginCallDriver = { call };
    await expect(callConfiguredPluginTool({
      stateDir: disabledState,
      pluginId: "docs",
      toolName: "lookup",
      driver,
    })).rejects.toThrow(/disabled/i);

    const enabledState = await temp();
    await registerPlugin({
      stateDir: enabledState,
      id: "docs",
      name: "Docs MCP",
      url: "https://example.org/mcp",
      enabled: true,
    });
    await expect(callConfiguredPluginTool({
      stateDir: enabledState,
      pluginId: "docs",
      toolName: "lookup",
      arguments: { value: "x".repeat(MAX_PLUGIN_CALL_ARGUMENT_CHARS + 1) },
      driver,
    })).rejects.toThrow(/arguments exceed/i);
    expect(call).not.toHaveBeenCalled();
  });
});
