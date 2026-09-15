import { describe, expect, it, vi } from "vitest";
import { discoverPlugin, type PluginDiscoveryDriver } from "./client.js";
import type { PluginDefinition } from "./registry.js";

function plugin(enabled: boolean): PluginDefinition {
  return {
    id: "docs",
    name: "Docs MCP",
    enabled,
    transport: { kind: "streamable-http", url: "https://example.org/mcp", headers: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

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
});
