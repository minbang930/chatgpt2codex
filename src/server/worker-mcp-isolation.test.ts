import { createHash, randomBytes } from "node:crypto";
import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WORKER_CORE_TOOL_NAMES } from "../agents/dispatcher.js";
import { storeOwnerToken } from "../auth/owner-token.js";
import { registerPlugin } from "../plugins/registry.js";
import type { ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";

const OWNER_TOKEN = "unit-test-owner-token-worker-mcp";

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomPkceVerifier(): string {
  return base64Url(randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function makeCtx(stateDir: string, projectRoot: string): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  let currentSession: unknown = { activeProjectId: null, mode: "observe", lease: null };
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => currentSession,
      setSession: async (next) => {
        currentSession = next;
      },
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 10 * 1024 * 1024,
      maxPatchBytes: 10 * 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

async function startApp(ctx: ToolContext): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = await getFreePort();
  const running = createHttpServer(
    ctx,
    defaultHttpServerConfig({ host: "127.0.0.1", port, publicUrl: `http://127.0.0.1:${port}` }),
  );
  const server: Server = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      running.close();
    },
  };
}

async function registerOAuthClient(baseUrl: string): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = "https://chatgpt.com/aip/gpt/oauth/callback";
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT Worker Isolation Test",
    }),
  });
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error(`OAuth client registration failed: ${JSON.stringify(body)}`);
  return { clientId: body.client_id, redirectUri };
}

async function getAccessToken(baseUrl: string, resourcePath: "/mcp" | "/mcp/worker"): Promise<string> {
  const client = await registerOAuthClient(baseUrl);
  const verifier = randomPkceVerifier();
  const resource = `${baseUrl}${resourcePath}`;
  const url = new URL("/authorize", baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "chatgpt2codex");
  url.searchParams.set("state", "unit-test-state");
  url.searchParams.set("resource", resource);

  const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
  const page = await pageRes.text();
  const csrfToken = page.match(/name="csrf_token" value="([^"]+)"/u)?.[1];
  if (!csrfToken) throw new Error(`OAuth authorize page did not contain CSRF token: ${pageRes.status}`);

  const body = new URLSearchParams(url.searchParams);
  body.set("csrf_token", csrfToken);
  body.set("owner_token", OWNER_TOKEN);

  const authRes = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { origin: "https://chatgpt.com", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  const location = authRes.headers.get("location");
  if (!location) throw new Error(`OAuth authorization failed: ${authRes.status}`);
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get("code");
  if (!code) throw new Error(`OAuth authorization did not return code: ${location}`);

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code,
    code_verifier: verifier,
    resource,
  });
  const tokenRes = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokenJson)}`);
  return tokenJson.access_token;
}

async function connectMcpClient(
  baseUrl: string,
  endpointPath: "/mcp" | "/mcp/worker",
  accessToken: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${endpointPath}`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: `unit-test-${endpointPath}`, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("browser-worker MCP transport isolation", () => {
  let stateDir: string;
  let projectRoot: string;
  let stop: (() => Promise<void>) | undefined;
  const clients: Client[] = [];

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-worker-mcp-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-worker-mcp-project-"));
    await storeOwnerToken(stateDir, OWNER_TOKEN);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
    await stop?.();
    stop = undefined;
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  }, 20_000);

  it("keeps main plugin proxies while exposing only worker capability tools on /mcp/worker", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    await registerPlugin({
      stateDir,
      id: "configured-plugin",
      name: "Configured Plugin",
      url: "http://127.0.0.1:9/mcp",
      enabled: true,
    });
    const app = await startApp(ctx);
    stop = app.stop;

    const workerMetadataRes = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/mcp/worker`);
    expect(workerMetadataRes.ok).toBe(true);
    const workerMetadata = (await workerMetadataRes.json()) as { resource?: string };
    expect(workerMetadata.resource).toBe(`${app.baseUrl}/mcp/worker`);

    const mainToken = await getAccessToken(app.baseUrl, "/mcp");
    const workerToken = await getAccessToken(app.baseUrl, "/mcp/worker");

    const mainClient = await connectMcpClient(app.baseUrl, "/mcp", mainToken);
    clients.push(mainClient);
    const mainNames = (await mainClient.listTools()).tools.map((tool) => tool.name);
    expect(mainNames).toEqual(expect.arrayContaining(["plugin_list", "plugin_discover", "plugin_call"]));

    const workerClient = await connectMcpClient(app.baseUrl, "/mcp/worker", workerToken);
    clients.push(workerClient);
    const workerNames = (await workerClient.listTools()).tools.map((tool) => tool.name).sort();
    const expectedWorkerNames = [
      "worker_finish",
      ...WORKER_CORE_TOOL_NAMES.map((name) => `worker_${name}`),
    ].sort();
    expect(workerNames).toEqual(expectedWorkerNames);
    expect(workerNames.some((name) => name.startsWith("plugin_"))).toBe(false);
    expect(workerNames).not.toContain("project_select");

    await expect(
      workerClient.callTool({ name: "plugin_list", arguments: {} }),
    ).rejects.toThrow(/not found|unknown tool/i);
  }, 30_000);

  it("binds OAuth resource audiences to their exact main/worker endpoints", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const mainToken = await getAccessToken(app.baseUrl, "/mcp");
    const workerToken = await getAccessToken(app.baseUrl, "/mcp/worker");

    await expect(connectMcpClient(app.baseUrl, "/mcp", workerToken)).rejects.toThrow();
    await expect(connectMcpClient(app.baseUrl, "/mcp/worker", mainToken)).rejects.toThrow();

    const mainClient = await connectMcpClient(app.baseUrl, "/mcp", mainToken);
    clients.push(mainClient);
    const workerClient = await connectMcpClient(app.baseUrl, "/mcp/worker", workerToken);
    clients.push(workerClient);

    expect((await mainClient.listTools()).tools.length).toBeGreaterThan(0);
    expect((await workerClient.listTools()).tools.length).toBeGreaterThan(0);
  }, 30_000);
});
