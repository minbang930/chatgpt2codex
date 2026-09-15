import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import {
  readPluginRegistry,
  registerPlugin,
  removePlugin,
  setPluginEnabled,
  summarizePlugin,
} from "../plugins/registry.js";
import { addToolCallProof } from "./tool-proof.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const localWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const securitySchemes = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;

const pluginIdSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const headerSchema = z.object({
  name: z.string().trim().min(1).max(128),
  valueEnv: z.string().trim().min(1).max(128),
}).strict();

function meta(invoking: string, invoked: string) {
  return {
    securitySchemes,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

function ok(tool: string, value: ReturnType<typeof makeResult>) {
  return { ...value, structuredContent: addToolCallProof(value.structuredContent, tool, value.isError !== true) };
}

function failed(tool: string, error: unknown) {
  const domain = error instanceof DomainError
    ? error
    : new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, error instanceof Error ? error.message : String(error));
  return ok(tool, makeResult({ error: domain.message, code: domain.code }, `Error [${domain.code}]: ${domain.message}`, true));
}

function requireLocalMutation(ctx: ToolContext): void {
  if (ctx.remote) {
    throw new DomainError(
      ErrorCode.PERMISSION_DENIED,
      "External MCP plugin configuration is local-only. Remote ChatGPT sessions may inspect plugin state but cannot change endpoints or enable plugins.",
    );
  }
}

export function registerPluginTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "plugin_list",
    {
      title: "List External MCP Plugins",
      description: "List configured external MCP plugins and whether their environment-backed headers are available. This does not connect to the plugins.",
      annotations: readOnly,
      _meta: meta("Listing external MCP plugins...", "External MCP plugins listed"),
      inputSchema: {},
    },
    async () => {
      try {
        const registry = await readPluginRegistry(ctx.stateDir);
        const plugins = registry.plugins.map((plugin) => summarizePlugin(plugin));
        return ok(
          "plugin_list",
          makeResult(
            { plugins, total: plugins.length },
            plugins.length === 0 ? "No external MCP plugins are configured." : `Found ${plugins.length} configured external MCP plugin(s).`,
          ),
        );
      } catch (error) {
        return failed("plugin_list", error);
      }
    },
  );

  server.registerTool(
    "plugin_register",
    {
      title: "Register External MCP Plugin",
      description: "Locally register one Streamable HTTP MCP endpoint. Registration is disabled by default unless enabled is explicitly true. Header values are referenced by environment-variable name and are never stored in plugins.json.",
      annotations: localWrite,
      _meta: meta("Registering external MCP plugin...", "External MCP plugin registered"),
      inputSchema: {
        id: pluginIdSchema,
        name: z.string().trim().min(1).max(120),
        url: z.string().trim().min(1).max(2048),
        headers: z.array(headerSchema).max(8).optional(),
        enabled: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        requireLocalMutation(ctx);
        const plugin = await registerPlugin({
          stateDir: ctx.stateDir,
          id: input.id,
          name: input.name,
          url: input.url,
          headers: input.headers,
          enabled: input.enabled,
        });
        return ok(
          "plugin_register",
          makeResult(
            { plugin: summarizePlugin(plugin) },
            `Registered external MCP plugin '${plugin.id}'${plugin.enabled ? " and enabled it" : " in disabled state"}.`,
          ),
        );
      } catch (error) {
        return failed("plugin_register", error);
      }
    },
  );

  server.registerTool(
    "plugin_set_enabled",
    {
      title: "Enable or Disable External MCP Plugin",
      description: "Locally change whether one configured external MCP plugin is eligible for discovery/connection. This does not grant plugin tools to browser workers.",
      annotations: localWrite,
      _meta: meta("Updating external MCP plugin...", "External MCP plugin updated"),
      inputSchema: { id: pluginIdSchema, enabled: z.boolean() },
    },
    async (input) => {
      try {
        requireLocalMutation(ctx);
        const plugin = await setPluginEnabled({ stateDir: ctx.stateDir, id: input.id, enabled: input.enabled });
        return ok(
          "plugin_set_enabled",
          makeResult({ plugin: summarizePlugin(plugin) }, `${input.enabled ? "Enabled" : "Disabled"} external MCP plugin '${plugin.id}'.`),
        );
      } catch (error) {
        return failed("plugin_set_enabled", error);
      }
    },
  );

  server.registerTool(
    "plugin_remove",
    {
      title: "Remove External MCP Plugin",
      description: "Locally remove one external MCP plugin configuration. This changes only runtime-owned plugins.json state.",
      annotations: destructive,
      _meta: meta("Removing external MCP plugin...", "External MCP plugin removed"),
      inputSchema: { id: pluginIdSchema },
    },
    async (input) => {
      try {
        requireLocalMutation(ctx);
        const removed = await removePlugin(ctx.stateDir, input.id);
        if (!removed) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Plugin not found: ${input.id}`);
        return ok("plugin_remove", makeResult({ id: input.id, removed: true }, `Removed external MCP plugin '${input.id}'.`));
      } catch (error) {
        return failed("plugin_remove", error);
      }
    },
  );
}
