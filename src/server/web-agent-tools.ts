import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import type { BrowserWorkerDriver } from "../agents/browser-controller.js";
import {
  installAgentStatusBrowserReconciliation,
  type BrowserTargetProbe,
} from "../agents/browser-recovery.js";
import { createChromeCdpBrowserWorkerDriver } from "../agents/chrome-cdp.js";
import { createChromeBrowserTargetProbe } from "../agents/chrome-liveness.js";
import { registerWebAgentLaunchTool } from "./web-agent-launch-tool.js";
import { registerWebAgentProjectTools } from "./web-agent-project-tools.js";
import { registerWebAgentStopTool } from "./web-agent-stop-tool.js";

export interface WebAgentToolDeps {
  browserDriver?: BrowserWorkerDriver;
  browserProbe?: BrowserTargetProbe;
}

export function registerWebAgentTools(
  server: McpServer,
  ctx: ToolContext,
  deps: WebAgentToolDeps = {},
): void {
  const driver = deps.browserDriver ?? createChromeCdpBrowserWorkerDriver(ctx.stateDir);
  const probe = deps.browserProbe ?? createChromeBrowserTargetProbe(ctx.stateDir);
  installAgentStatusBrowserReconciliation(server, ctx.stateDir, probe);
  registerWebAgentLaunchTool(server, ctx, driver);
  registerWebAgentStopTool(server, ctx, driver);
  registerWebAgentProjectTools(server, ctx);
}
