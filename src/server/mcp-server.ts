import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { installWorkerCompletionBrowserCleanup } from "../agents/browser-completion.js";
import { installAgentNotificationPiggyback } from "../agents/piggyback.js";
import { WORKER_CORE_TOOL_NAMES } from "../agents/dispatcher.js";
import { emitSessionStartHook } from "../hooks/session-start.js";
import { installToolLifecycleHooks } from "../hooks/tool-lifecycle.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerPluginCallTools } from "./plugin-call-tools.js";
import { registerPluginDiscoveryTools } from "./plugin-discovery-tools.js";
import { registerPluginTools } from "./plugin-tools.js";
import { registerSkillSecurityTools } from "./skill-security-tools.js";
import { registerSkillTools } from "./skill-tools.js";
import { registerTools } from "./tools.js";
import { registerWebAgentTools } from "./web-agent-tools.js";
import { registerWorkerTools } from "./worker-tools.js";

interface RegisteredToolRegistry {
  _registeredTools?: Record<string, unknown>;
}

function retainWorkerOnlyTools(server: McpServer): void {
  const registered = (server as unknown as RegisteredToolRegistry)._registeredTools;
  if (!registered) return;
  const allowed = new Set<string>([
    "worker_finish",
    ...WORKER_CORE_TOOL_NAMES.map((name) => `worker_${name}`),
  ]);
  for (const name of Object.keys(registered)) {
    if (!allowed.has(name)) delete registered[name];
  }
}

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
  registerPluginCallTools(server, ctx);
  installToolLifecycleHooks(server, ctx);
  await emitSessionStartHook(ctx);
  return server;
}

/**
 * Build the remote catalog used by isolated browser workers. Core tools are
 * registered first only as schema/metadata sources for registerWorkerTools;
 * the public registry is then reduced to worker-prefixed mirrors plus the
 * capability-protected worker_finish handshake before the server is connected
 * to a transport. Main-agent, plugin, skill, Computer Use, and agent-manager
 * tools therefore never enter this transport's tools/list or tools/call path.
 */
export async function createWorkerServer(ctx: ToolContext): Promise<McpServer> {
  const server = new McpServer({ name: "chatgpt2codex-worker", version: "0.1.1" });
  registerTools(server, ctx);
  registerAgentTools(server, ctx);
  installWorkerCompletionBrowserCleanup(server, ctx.stateDir);
  registerWorkerTools(server, ctx);
  retainWorkerOnlyTools(server);
  installToolLifecycleHooks(server, ctx);
  await emitSessionStartHook(ctx);
  return server;
}
