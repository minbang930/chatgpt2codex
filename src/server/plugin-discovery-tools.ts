import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import { discoverConfiguredPlugins } from "../plugins/client.js";
import { addToolCallProof } from "./tool-proof.js";

const pluginIdSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const securitySchemes = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;

function result(tool: string, value: ReturnType<typeof makeResult>) {
  return { ...value, structuredContent: addToolCallProof(value.structuredContent, tool, value.isError !== true) };
}

export function registerPluginDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "plugin_discover",
    {
      title: "Discover External MCP Plugin Tools",
      description: "Connect to enabled external MCP plugins on demand and return a bounded tool catalog. Failures stay isolated to each plugin.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        securitySchemes,
        ui: { visibility: ["model"] },
        "openai/visibility": "public",
        "openai/toolInvocation/invoking": "Discovering external MCP plugin tools...",
        "openai/toolInvocation/invoked": "External MCP plugin discovery finished",
      },
      inputSchema: { id: pluginIdSchema.optional() },
    },
    async (input) => {
      try {
        const reports = await discoverConfiguredPlugins(ctx.stateDir, { pluginId: input.id });
        if (input.id && reports.length === 0) {
          throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Plugin not found: ${input.id}`);
        }
        const connected = reports.filter((report) => report.status === "ok").length;
        const failed = reports.filter((report) => report.status === "error").length;
        return result(
          "plugin_discover",
          makeResult(
            { reports, total: reports.length, connected, failed },
            reports.length === 0
              ? "No external MCP plugins are configured."
              : `Discovery finished for ${reports.length} plugin(s): ${connected} connected, ${failed} failed.`,
          ),
        );
      } catch (error) {
        const domain = error instanceof DomainError
          ? error
          : new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, error instanceof Error ? error.message : String(error));
        return result(
          "plugin_discover",
          makeResult({ error: domain.message, code: domain.code }, `Error [${domain.code}]: ${domain.message}`, true),
        );
      }
    },
  );
}
