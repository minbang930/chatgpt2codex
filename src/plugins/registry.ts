import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const REGISTRY_FILE = "plugins.json";
const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_PLUGINS = 16;
export const MAX_PLUGIN_HEADERS = 8;
export const MAX_PLUGIN_SKILL_SOURCES = 8;

const pluginIdSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const pluginNameSchema = z.string().trim().min(1).max(120);
const envNameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const headerNameSchema = z.string().trim().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const skillNameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const gitRefSchema = z.string().trim().min(1).max(200).refine((value) => !value.startsWith("-"), "ref must not start with '-'");

const headerSchema = z.object({
  name: headerNameSchema,
  valueEnv: envNameSchema,
}).strict();

const skillSourceSchema = z.object({
  id: pluginIdSchema,
  source: z.string().trim().min(1).max(2048),
  ref: gitRefSchema.optional(),
  skillName: skillNameSchema.optional(),
}).strict();

const transportSchema = z.object({
  kind: z.literal("streamable-http"),
  url: z.string().trim().min(1).max(2048),
  headers: z.array(headerSchema).max(MAX_PLUGIN_HEADERS).optional().default([]),
}).strict();

const pluginSchema = z.object({
  id: pluginIdSchema,
  name: pluginNameSchema,
  enabled: z.boolean(),
  transport: transportSchema,
  skillSources: z.array(skillSourceSchema).max(MAX_PLUGIN_SKILL_SOURCES).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const registrySchema = z.object({
  version: z.literal(1),
  plugins: z.array(pluginSchema).max(MAX_PLUGINS),
}).strict();

export type PluginHeaderConfig = z.infer<typeof headerSchema>;
export type PluginSkillSource = z.infer<typeof skillSourceSchema>;
export type PluginTransport = z.infer<typeof transportSchema>;
export type PluginDefinition = z.infer<typeof pluginSchema>;
export type PluginRegistry = z.infer<typeof registrySchema>;

export interface PluginPublicSummary {
  id: string;
  name: string;
  enabled: boolean;
  transport: {
    kind: "streamable-http";
    url: string;
    headers: Array<{ name: string; valueEnv: string; available: boolean }>;
  };
  skillSources: PluginSkillSource[];
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedPluginConnection {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
}

function registryPath(stateDir: string): string {
  return path.join(stateDir, REGISTRY_FILE);
}

function emptyRegistry(): PluginRegistry {
  return { version: 1, plugins: [] };
}

function configError(message: string): DomainError {
  return new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Plugin registry invalid: ${message}`);
}

function validateUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError("plugin URL must be a valid absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw configError("plugin URL must not embed credentials");
  }
  if (parsed.search) {
    throw configError("plugin URL query strings are not allowed; use environment-backed headers for credentials");
  }
  if (parsed.hash) {
    throw configError("plugin URL fragments are not allowed");
  }

  const host = parsed.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    throw configError("plain HTTP plugin URLs are allowed only for loopback hosts");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw configError("plugin URL must use HTTPS, or HTTP on a loopback host");
  }
  return parsed.toString();
}

function normalizeSkillSourceUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError("plugin skill source must be a valid HTTPS Git URL");
  }
  if (parsed.protocol !== "https:") throw configError("plugin skill source must use HTTPS");
  if (parsed.username || parsed.password) throw configError("plugin skill source must not embed credentials");
  if (parsed.search || parsed.hash) throw configError("plugin skill source must not contain a query string or fragment");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeHeaders(headers: PluginHeaderConfig[] | undefined): PluginHeaderConfig[] {
  const normalized = headers ?? [];
  const seen = new Set<string>();
  return normalized.map((header) => {
    const name = headerNameSchema.parse(header.name);
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length") {
      throw configError(`header '${name}' is managed by the HTTP transport and cannot be configured`);
    }
    if (seen.has(lower)) throw configError(`duplicate plugin header '${name}'`);
    seen.add(lower);
    return { name, valueEnv: envNameSchema.parse(header.valueEnv) };
  });
}

function normalizeSkillSources(sources: PluginSkillSource[] | undefined): PluginSkillSource[] {
  const normalized = sources ?? [];
  const seen = new Set<string>();
  return normalized.map((source) => {
    const id = pluginIdSchema.parse(source.id);
    if (seen.has(id)) throw configError(`duplicate plugin skill source '${id}'`);
    seen.add(id);
    return {
      id,
      source: normalizeSkillSourceUrl(source.source),
      ...(source.ref ? { ref: gitRefSchema.parse(source.ref) } : {}),
      ...(source.skillName ? { skillName: skillNameSchema.parse(source.skillName) } : {}),
    };
  });
}

function normalizeTransport(transport: PluginTransport): PluginTransport {
  return {
    kind: "streamable-http",
    url: validateUrl(transport.url),
    headers: normalizeHeaders(transport.headers),
  };
}

async function writeRegistry(stateDir: string, registry: PluginRegistry): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  const validated = registrySchema.parse(registry);
  const target = registryPath(stateDir);
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await rename(temp, target);
}

export async function readPluginRegistry(stateDir: string): Promise<PluginRegistry> {
  const target = registryPath(stateDir);
  let raw: string;
  try {
    const bytes = await readFile(target);
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw configError(`config exceeds ${MAX_CONFIG_BYTES} bytes`);
    raw = bytes.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw configError(`config is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = registrySchema.safeParse(decoded);
  if (!parsed.success) throw configError(parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return {
    version: 1,
    plugins: parsed.data.plugins.map((plugin) => ({
      ...plugin,
      transport: normalizeTransport(plugin.transport),
      skillSources: normalizeSkillSources(plugin.skillSources),
    })),
  };
}

export async function registerPlugin(params: {
  stateDir: string;
  id: string;
  name: string;
  url: string;
  headers?: PluginHeaderConfig[];
  skillSources?: PluginSkillSource[];
  enabled?: boolean;
}): Promise<PluginDefinition> {
  const registry = await readPluginRegistry(params.stateDir);
  if (registry.plugins.length >= MAX_PLUGINS) {
    throw new DomainError(ErrorCode.QUOTA_EXCEEDED, `At most ${MAX_PLUGINS} external MCP plugins may be configured`);
  }
  const id = pluginIdSchema.parse(params.id);
  if (registry.plugins.some((plugin) => plugin.id === id)) {
    throw new DomainError(ErrorCode.FILE_EXISTS, `Plugin '${id}' is already configured`);
  }
  const now = new Date().toISOString();
  const plugin: PluginDefinition = {
    id,
    name: pluginNameSchema.parse(params.name),
    enabled: params.enabled ?? false,
    transport: normalizeTransport({ kind: "streamable-http", url: params.url, headers: params.headers ?? [] }),
    skillSources: normalizeSkillSources(params.skillSources),
    createdAt: now,
    updatedAt: now,
  };
  registry.plugins.push(plugin);
  await writeRegistry(params.stateDir, registry);
  return plugin;
}

export async function setPluginEnabled(params: {
  stateDir: string;
  id: string;
  enabled: boolean;
}): Promise<PluginDefinition> {
  const registry = await readPluginRegistry(params.stateDir);
  const id = pluginIdSchema.parse(params.id);
  const index = registry.plugins.findIndex((plugin) => plugin.id === id);
  if (index < 0) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Plugin not found: ${id}`);
  const current = registry.plugins[index]!;
  const updated: PluginDefinition = { ...current, enabled: params.enabled, updatedAt: new Date().toISOString() };
  registry.plugins[index] = updated;
  await writeRegistry(params.stateDir, registry);
  return updated;
}

export async function removePlugin(stateDir: string, idInput: string): Promise<boolean> {
  const registry = await readPluginRegistry(stateDir);
  const id = pluginIdSchema.parse(idInput);
  const next = registry.plugins.filter((plugin) => plugin.id !== id);
  if (next.length === registry.plugins.length) return false;
  await writeRegistry(stateDir, { version: 1, plugins: next });
  return true;
}

export function summarizePlugin(plugin: PluginDefinition, env: NodeJS.ProcessEnv = process.env): PluginPublicSummary {
  return {
    id: plugin.id,
    name: plugin.name,
    enabled: plugin.enabled,
    transport: {
      kind: plugin.transport.kind,
      url: plugin.transport.url,
      headers: plugin.transport.headers.map((header) => ({
        name: header.name,
        valueEnv: header.valueEnv,
        available: typeof env[header.valueEnv] === "string" && env[header.valueEnv]!.length > 0,
      })),
    },
    skillSources: plugin.skillSources.map((source) => ({ ...source })),
    createdAt: plugin.createdAt,
    updatedAt: plugin.updatedAt,
  };
}

export function resolvePluginConnection(
  plugin: PluginDefinition,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPluginConnection {
  const headers: Record<string, string> = {};
  for (const header of plugin.transport.headers) {
    const value = env[header.valueEnv];
    if (!value) {
      throw new DomainError(
        ErrorCode.PERMISSION_DENIED,
        `Plugin '${plugin.id}' requires environment variable ${header.valueEnv} for header ${header.name}`,
      );
    }
    headers[header.name] = value;
  }
  return { id: plugin.id, name: plugin.name, url: plugin.transport.url, headers };
}
