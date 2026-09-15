import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { installWorkerCompletionBrowserCleanup } from "../agents/browser-completion.js";
import { installAgentNotificationPiggyback } from "../agents/piggyback.js";
import { emitSessionStartHook } from "../hooks/session-start.js";
import { installToolLifecycleHooks } from "../hooks/tool-lifecycle.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerTools } from "./tools.js";
import { registerWebAgentTools } from "./web-agent-tools.js";
import { registerWorkerTools } from "./worker-tools.js";

/**
 * Construct and configure one MCP server instance with all tools registered
 * against ctx. HTTP creates one instance per initialized MCP session; stdio
 * creates one instance for its single transport.
 */
export async function createServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({
    name: "chatgpt2codex",
    version: "0.1.1",
  });

  registerTools(server, ctx);
  installAgentNotificationPiggyback(server, ctx.stateDir);
  registerAgentTools(server, ctx);
  installWorkerCompletionBrowserCleanup(server, ctx.stateDir);
  registerWebAgentTools(server, ctx);
  registerWorkerTools(server, ctx);

  // Install lifecycle hooks only after every tool surface has registered so a
  // single wrapper covers Core, agent, Web-agent, and worker tools without
  // duplicating hook calls inside individual handlers.
  installToolLifecycleHooks(server, ctx);

  // SessionStart is intentionally best-effort inside the hook layer: malformed
  // config, hook process failures, timeouts, and audit failures are reported or
  // isolated there and never prevent this server instance from being returned.
  await emitSessionStartHook(ctx);

  return server;
}
