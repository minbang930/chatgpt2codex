import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { installWorkerCompletionBrowserCleanup } from "../agents/browser-completion.js";
import { installAgentNotificationPiggyback } from "../agents/piggyback.js";
import { emitSessionStartHook } from "../hooks/session-start.js";
import { installToolLifecycleHooks } from "../hooks/tool-lifecycle.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerPluginDiscoveryTools } from "./plugin-discovery-tools.js";
import { registerPluginTools } from "./plugin-tools.js";
import { registerSkillSecurityTools } from "./skill-security-tools.js";
import { registerSkillTools } from "./skill-tools.js";
import { registerTools } from "./tools.js";
import { registerWebAgentTools } from "./web-agent-tools.js";
import { registerWorkerTools } from "./worker-tools.js";

export async function createServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({ name: "chatgpt2codex", version: "0.1.1" });
  registerTools(server, ctx);
  installAgentNotificationPiggyback(server, ctx.stateDir);
  registerAgentTools(server, ctx);
  installWorkerCompletionBrowserCleanup(server, ctx.stateDir);
  registerWebAgentTools(server, ctx);
  registerWorkerTools(server, ctx);
  registerSkillTools(server, ctx);
  registerSkillSecurityTools(server, ctx);
  registerPluginTools(server, ctx);
  registerPluginDiscoveryTools(server, ctx);
  installToolLifecycleHooks(server, ctx);
  await emitSessionStartHook(ctx);
  return server;
}
