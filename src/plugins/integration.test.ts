import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { callConfiguredPluginTool, discoverConfiguredPlugins } from "./client.js";
import { registerPlugin } from "./registry.js";

const dirs: string[] = [];

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "c2c-plugin-live-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external MCP plugin loopback integration", () => {
  it("registers, discovers, and calls a real Streamable HTTP MCP server", async () => {
    const app = createMcpExpressApp({ host: "127.0.0.1" });
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const servers: McpServer[] = [];

    app.all("/mcp", async (req, res) => {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (transport) sessions.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) sessions.delete(transport.sessionId);
        };

        const mcp = new McpServer({ name: "loopback-plugin", version: "1.0.0" });
        mcp.registerTool(
          "echo",
          {
            title: "Echo",
            description: "Echo one value",
            inputSchema: { value: z.string() },
          },
          async (input) => ({
            content: [{ type: "text", text: input.value }],
            structuredContent: { value: input.value },
          }),
        );
        servers.push(mcp);
        await mcp.connect(transport);
      }

      if (!transport) {
        res.status(400).json({ error: "missing MCP session" });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    });

    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("loopback test server did not expose a TCP port");

    try {
      const stateDir = await makeTemp();
      await registerPlugin({
        stateDir,
        id: "loopback",
        name: "Loopback Plugin",
        url: `http://127.0.0.1:${address.port}/mcp`,
        enabled: true,
      });

      const discovery = await discoverConfiguredPlugins(stateDir, { pluginId: "loopback" });
      expect(discovery).toHaveLength(1);
      expect(discovery[0]).toMatchObject({
        status: "ok",
        server: { name: "loopback-plugin", version: "1.0.0" },
        tools: [expect.objectContaining({ name: "echo" })],
      });

      const call = await callConfiguredPluginTool({
        stateDir,
        pluginId: "loopback",
        toolName: "echo",
        arguments: { value: "hello-plugin" },
      });
      expect(call.resultTruncated).toBe(false);
      expect(call.result).toMatchObject({
        content: [{ type: "text", text: "hello-plugin" }],
        structuredContent: { value: "hello-plugin" },
      });
    } finally {
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      for (const server of servers) await server.close().catch(() => undefined);
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 20_000);
});
