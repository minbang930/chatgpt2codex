import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import { callConfiguredPluginTool } from "../plugins/client.js";
import { addToolCallProof } from "./tool-proof.js";

const securitySchemes = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;
const pluginIdSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const toolNameSchema = z.string().trim().min(1).max(256);

function result(tool: string, value: ReturnType<typeof makeResult>) {
  return { ...value, structuredContent: addToolCallProof(value.structuredContent, tool, value.isError !== true) };
}

export function registerPluginCallTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "plugin_call",
    {
      title: "Call External MCP Plugin Tool",
      description: "Call one explicitly named tool on one locally enabled external MCP plugin through the fixed proxy. Remote plugin tools are never dynamically added to the Core tool registry or inherited by browser workers.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: {
        securitySchemes,
        ui: { visibility: ["model"] },
        "openai/visibility": "public",
        "openai/toolInvocation/invoking": "Calling external MCP plugin tool...",
        "openai/toolInvocation/invoked": "External MCP plugin tool finished",
      },
      inputSchema: {
        pluginId: pluginIdSchema,
        toolName: toolNameSchema,
        arguments: z.record(z.unknown()).optional().default({}),
      },
    },
    async (input) => {
      try {
        const report = await callConfiguredPluginTool({
          stateDir: ctx.stateDir,
          pluginId: input.pluginId,
          toolName: input.toolName,
          arguments: input.arguments,
        });
        return result(
          "plugin_call",
          makeResult(
            { report },
            `External MCP plugin '${report.pluginId}' tool '${report.toolName}' completed${report.resultTruncated ? " with a bounded result preview" : ""}.`,
          ),
        );
      } catch (error) {
        const domain = error instanceof DomainError
          ? error
          : new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, error instanceof Error ? error.message : String(error));
        return result(
          "plugin_call",
          makeResult({ error: domain.message, code: domain.code }, `Error [${domain.code}]: ${domain.message}`, true),
        );
      }
    },
  );
}
