import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  readPluginRegistry,
  resolvePluginConnection,
  type PluginDefinition,
  type ResolvedPluginConnection,
} from "./registry.js";

export const DEFAULT_PLUGIN_DISCOVERY_TIMEOUT_MS = 8_000;
export const MAX_DISCOVERED_PLUGIN_TOOLS = 64;
export const MAX_PLUGIN_TOOL_DESCRIPTION_CHARS = 1_000;
export const MAX_PLUGIN_TOOL_SCHEMA_CHARS = 32_000;
export const MAX_PLUGIN_DISCOVERY_SCHEMA_CHARS = 128_000;

export interface PluginDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  schemaTruncated?: boolean;
}

export interface PluginDiscoveryReport {
  pluginId: string;
  pluginName: string;
  status: "ok" | "disabled" | "error";
  durationMs: number;
  server?: { name?: string; version?: string };
  tools: PluginDiscoveredTool[];
  totalTools: number;
  truncated: boolean;
  error?: string;
}

export interface PluginDiscoveryDriver {
  discover(connection: ResolvedPluginConnection, timeoutMs: number): Promise<{
    server?: { name?: string; version?: string };
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }>;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}

function schemaCost(schema: unknown): number {
  if (schema === undefined) return 0;
  try {
    return JSON.stringify(schema).length;
  } catch {
    return MAX_PLUGIN_TOOL_SCHEMA_CHARS + 1;
  }
}

function boundTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): { tools: PluginDiscoveredTool[]; truncated: boolean } {
  const bounded: PluginDiscoveredTool[] = [];
  let schemaChars = 0;
  let truncated = tools.length > MAX_DISCOVERED_PLUGIN_TOOLS;

  for (const tool of tools.slice(0, MAX_DISCOVERED_PLUGIN_TOOLS)) {
    const cost = schemaCost(tool.inputSchema);
    const includeSchema = cost <= MAX_PLUGIN_TOOL_SCHEMA_CHARS && schemaChars + cost <= MAX_PLUGIN_DISCOVERY_SCHEMA_CHARS;
    if (includeSchema) schemaChars += cost;
    else if (tool.inputSchema !== undefined) truncated = true;
    bounded.push({
      name: tool.name.slice(0, 256),
      ...(tool.description
        ? { description: tool.description.slice(0, MAX_PLUGIN_TOOL_DESCRIPTION_CHARS) }
        : {}),
      ...(includeSchema && tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(!includeSchema && tool.inputSchema !== undefined ? { schemaTruncated: true } : {}),
    });
  }
  return { tools: bounded, truncated };
}

export const sdkPluginDiscoveryDriver: PluginDiscoveryDriver = {
  async discover(connection, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("external MCP discovery timed out")), timeoutMs);
    const client = new Client({ name: "chatgpt2codex-plugin-discovery", version: "0.2.0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: {
          headers: connection.headers,
          signal: controller.signal,
        },
      });
      await client.connect(transport);
      const listed = await client.listTools();
      const serverVersion = client.getServerVersion();
      return {
        server: serverVersion ? { name: serverVersion.name, version: serverVersion.version } : undefined,
        tools: listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => undefined);
    }
  },
};

export async function discoverPlugin(
  plugin: PluginDefinition,
  options: { driver?: PluginDiscoveryDriver; timeoutMs?: number } = {},
): Promise<PluginDiscoveryReport> {
  const startedAt = Date.now();
  if (!plugin.enabled) {
    return {
      pluginId: plugin.id,
      pluginName: plugin.name,
      status: "disabled",
      durationMs: 0,
      tools: [],
      totalTools: 0,
      truncated: false,
    };
  }

  try {
    const connection = resolvePluginConnection(plugin);
    const discovered = await (options.driver ?? sdkPluginDiscoveryDriver).discover(
      connection,
      options.timeoutMs ?? DEFAULT_PLUGIN_DISCOVERY_TIMEOUT_MS,
    );
    const bounded = boundTools(discovered.tools);
    return {
      pluginId: plugin.id,
      pluginName: plugin.name,
      status: "ok",
      durationMs: Date.now() - startedAt,
      server: discovered.server,
      tools: bounded.tools,
      totalTools: discovered.tools.length,
      truncated: bounded.truncated,
    };
  } catch (error) {
    return {
      pluginId: plugin.id,
      pluginName: plugin.name,
      status: "error",
      durationMs: Date.now() - startedAt,
      tools: [],
      totalTools: 0,
      truncated: false,
      error: boundedError(error),
    };
  }
}

export async function discoverConfiguredPlugins(
  stateDir: string,
  options: { driver?: PluginDiscoveryDriver; timeoutMs?: number; pluginId?: string } = {},
): Promise<PluginDiscoveryReport[]> {
  const registry = await readPluginRegistry(stateDir);
  const selected = options.pluginId
    ? registry.plugins.filter((plugin) => plugin.id === options.pluginId)
    : registry.plugins;
  return Promise.all(selected.map((plugin) => discoverPlugin(plugin, options)));
}
