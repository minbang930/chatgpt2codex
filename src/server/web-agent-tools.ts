import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import type { BrowserWorkerDriver } from "../agents/browser-controller.js";
import {
  installAgentStatusBrowserReconciliation,
  type BrowserCompletionProbe,
  type BrowserTargetProbe,
} from "../agents/browser-recovery.js";
import { createChromeCdpBrowserWorkerDriver } from "../agents/chrome-cdp.js";
import { createChromeBrowserCompletionProbe } from "../agents/chrome-completion.js";
import { createChromeBrowserTargetProbe } from "../agents/chrome-liveness.js";
import { registerWebAgentLaunchTool } from "./web-agent-launch-tool.js";
import { registerWebAgentProjectTools } from "./web-agent-project-tools.js";
import { registerWebAgentStopTool } from "./web-agent-stop-tool.js";
import { registerWorkerExecutionSettingsTools } from "./worker-execution-settings-tools.js";

export interface WebAgentToolDeps {
  browserDriver?: BrowserWorkerDriver;
  browserProbe?: BrowserTargetProbe;
  browserCompletionProbe?: BrowserCompletionProbe;
}

export function registerWebAgentTools(
  server: McpServer,
  ctx: ToolContext,
  deps: WebAgentToolDeps = {},
): void {
  const driver = deps.browserDriver ?? createChromeCdpBrowserWorkerDriver(ctx.stateDir);
  const probe = deps.browserProbe ?? createChromeBrowserTargetProbe(ctx.stateDir);
  const completionProbe = deps.browserCompletionProbe ?? createChromeBrowserCompletionProbe(ctx.stateDir);
  installAgentStatusBrowserReconciliation(server, ctx.stateDir, probe, completionProbe);
  registerWebAgentLaunchTool(server, ctx, driver);
  registerWebAgentStopTool(server, ctx, driver);
  registerWebAgentProjectTools(server, ctx);
  registerWorkerExecutionSettingsTools(server, ctx);
}
