import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { registerPluginCallTools } from "../server/plugin-call-tools.js";
import { registerPluginDiscoveryTools } from "../server/plugin-discovery-tools.js";
import { registerPluginTools } from "../server/plugin-tools.js";
import { registerSkillSecurityTools } from "../server/skill-security-tools.js";
import { registerSkillTools } from "../server/skill-tools.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "c2c-plugin-live-"));
  dirs.push(dir);
  return dir;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

function gitConfigQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function makeCtx(workspaceRoot: string, stateDir: string): ToolContext {
  return {
    workspaceRoot,
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => undefined,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot,
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
    remote: false,
  };
}

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function handlers(server: McpServer): Record<string, Handler> {
  return Object.fromEntries(
    Object.entries((server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {})
      .flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external MCP plugin loopback integration", () => {
  it("runs the full Core plugin lifecycle against a real Streamable HTTP MCP server", async () => {
    const app = createMcpExpressApp({ host: "127.0.0.1" });
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const servers: McpServer[] = [];

    app.all("/mcp", async (req, res) => {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (transport) sessions.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) sessions.delete(transport.sessionId);
        };

        const mcp = new McpServer({ name: "loopback-plugin", version: "1.0.0" });
        mcp.registerTool(
          "echo",
          {
            title: "Echo",
            description: "Echo one value",
            inputSchema: { value: z.string() },
          },
          async (input) => ({
            content: [{ type: "text", text: input.value }],
            structuredContent: { value: input.value },
          }),
        );
        servers.push(mcp);
        await mcp.connect(transport);
      }

      if (!transport) {
        res.status(400).json({ error: "missing MCP session" });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    });

    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("loopback test server did not expose a TCP port");

    try {
      const workspace = await makeTemp();
      const stateDir = await makeTemp();
      const core = new McpServer({ name: "plugin-core-smoke", version: "1" });
      const ctx = makeCtx(workspace, stateDir);
      registerPluginTools(core, ctx);
      registerPluginDiscoveryTools(core, ctx);
      registerPluginCallTools(core, ctx);
      const tool = handlers(core);

      const registered = await tool.plugin_register?.({
        id: "loopback",
        name: "Loopback Plugin",
        url: `http://127.0.0.1:${address.port}/mcp`,
      });
      expect(registered?.isError).not.toBe(true);
      expect(registered?.structuredContent).toMatchObject({
        plugin: { id: "loopback", enabled: false },
      });

      const enabled = await tool.plugin_set_enabled?.({ id: "loopback", enabled: true });
      expect(enabled?.isError).not.toBe(true);
      expect(enabled?.structuredContent).toMatchObject({
        plugin: { id: "loopback", enabled: true },
      });

      const discovery = await tool.plugin_discover?.({ id: "loopback" });
      expect(discovery?.isError).not.toBe(true);
      expect(discovery?.structuredContent).toMatchObject({
        total: 1,
        connected: 1,
        failed: 0,
        reports: [
          expect.objectContaining({
            pluginId: "loopback",
            status: "ok",
            server: { name: "loopback-plugin", version: "1.0.0" },
            tools: [expect.objectContaining({ name: "echo" })],
          }),
        ],
      });

      const call = await tool.plugin_call?.({
        pluginId: "loopback",
        toolName: "echo",
        arguments: { value: "hello-plugin" },
      });
      expect(call?.isError).not.toBe(true);
      expect(call?.structuredContent).toMatchObject({
        report: {
          pluginId: "loopback",
          toolName: "echo",
          resultTruncated: false,
          result: {
            content: [{ type: "text", text: "hello-plugin" }],
            structuredContent: { value: "hello-plugin" },
          },
        },
      });

      const disabled = await tool.plugin_set_enabled?.({ id: "loopback", enabled: false });
      expect(disabled?.isError).not.toBe(true);
      expect(disabled?.structuredContent).toMatchObject({
        plugin: { id: "loopback", enabled: false },
      });

      const disabledCall = await tool.plugin_call?.({
        pluginId: "loopback",
        toolName: "echo",
        arguments: { value: "must-not-run" },
      });
      expect(disabledCall?.isError).toBe(true);
      expect(disabledCall?.structuredContent).toMatchObject({ code: "PERMISSION_DENIED" });

      const removed = await tool.plugin_remove?.({ id: "loopback" });
      expect(removed?.isError).not.toBe(true);
      expect(removed?.structuredContent).toMatchObject({ id: "loopback", removed: true });

      const listed = await tool.plugin_list?.({});
      expect(listed?.isError).not.toBe(true);
      expect(listed?.structuredContent).toMatchObject({ total: 0, plugins: [] });
    } finally {
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      for (const server of servers) await server.close().catch(() => undefined);
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 20_000);

  it("keeps plugin skillSources inert until the normal external Git skill lifecycle is explicitly used", async () => {
    const workspace = await makeTemp();
    const stateDir = await makeTemp();
    const sourceRepo = path.join(workspace, "plugin-skill-source");
    const skillDir = path.join(sourceRepo, "skills", "plugin-reviewer");
    const marker = path.join(workspace, "skill-script-ran.txt");
    await mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: plugin-reviewer\ndescription: Review changes supplied by a plugin-declared skill source\n---\n\nReview the requested changes and run focused tests.\n",
      "utf8",
    );
    await writeFile(
      path.join(skillDir, "scripts", "must-not-run.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
      "utf8",
    );

    await runGit(sourceRepo, ["init"]);
    await runGit(sourceRepo, ["config", "user.name", "chatgpt2codex test"]);
    await runGit(sourceRepo, ["config", "user.email", "test@example.invalid"]);
    await runGit(sourceRepo, ["add", "."]);
    await runGit(sourceRepo, ["commit", "-m", "add plugin skill fixture"]);
    const resolvedCommit = await runGit(sourceRepo, ["rev-parse", "HEAD"]);

    const declaredSource = "https://skills.example.invalid/plugin-reviewer.git";
    const gitConfig = path.join(workspace, "gitconfig");
    await writeFile(
      gitConfig,
      `[url "${gitConfigQuote(pathToFileURL(sourceRepo).href)}"]\n\tinsteadOf = ${declaredSource}\n[protocol "file"]\n\tallow = always\n`,
      "utf8",
    );

    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    try {
      const core = new McpServer({ name: "plugin-skill-source-smoke", version: "1" });
      const ctx = makeCtx(workspace, stateDir);
      registerPluginTools(core, ctx);
      registerSkillTools(core, ctx);
      registerSkillSecurityTools(core, ctx);
      const tool = handlers(core);

      const registered = await tool.plugin_register?.({
        id: "review-plugin",
        name: "Review Plugin",
        url: "https://plugin.example.invalid/mcp",
        skillSources: [
          {
            id: "reviewer",
            source: declaredSource,
            skillName: "plugin-reviewer",
          },
        ],
      });
      expect(registered?.isError).not.toBe(true);
      expect(registered?.structuredContent).toMatchObject({
        plugin: {
          id: "review-plugin",
          enabled: false,
          skillSources: [
            {
              id: "reviewer",
              source: declaredSource,
              skillName: "plugin-reviewer",
            },
          ],
        },
      });

      const beforeInstall = await tool.skill_list?.({});
      expect(beforeInstall?.isError).not.toBe(true);
      expect(beforeInstall?.structuredContent).toMatchObject({ skills: [], activeSkillNames: [] });
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const pluginList = await tool.plugin_list?.({});
      expect(pluginList?.isError).not.toBe(true);
      expect(pluginList?.structuredContent).toMatchObject({
        total: 1,
        plugins: [
          expect.objectContaining({
            id: "review-plugin",
            skillSources: [
              {
                id: "reviewer",
                source: declaredSource,
                skillName: "plugin-reviewer",
              },
            ],
          }),
        ],
      });

      const declaration = (pluginList?.structuredContent?.plugins as Array<{
        skillSources: Array<{ source: string; skillName?: string; ref?: string }>;
      }> | undefined)?.[0]?.skillSources[0];
      if (!declaration) throw new Error("plugin skill source declaration was not returned");

      const installed = await tool.skill_install?.({
        source: declaration.source,
        scope: "global",
        ...(declaration.skillName ? { skillName: declaration.skillName } : {}),
        ...(declaration.ref ? { ref: declaration.ref } : {}),
      });
      expect(installed?.isError).not.toBe(true);
      expect(installed?.structuredContent).toMatchObject({
        name: "plugin-reviewer",
        scope: "global",
        sourceKind: "git",
        source: declaredSource,
        resolvedCommit,
        trust: {
          level: "external-git",
          managed: true,
          external: true,
          sourceKind: "git",
          source: declaredSource,
          resolvedCommit,
        },
      });

      const security = await tool.skill_security_status?.({ name: "plugin-reviewer" });
      expect(security?.isError).not.toBe(true);
      expect(security?.structuredContent).toMatchObject({
        name: "plugin-reviewer",
        installedScope: "global",
        trust: {
          level: "external-git",
          external: true,
          source: declaredSource,
          resolvedCommit,
        },
        securityScan: {
          complete: true,
          blockingFindings: 0,
        },
      });

      const activated = await tool.skill_activate?.({ name: "plugin-reviewer", activationScope: "global" });
      expect(activated?.isError).not.toBe(true);
      expect(activated?.structuredContent).toMatchObject({
        name: "plugin-reviewer",
        activationScope: "global",
        activeSkillNames: ["plugin-reviewer"],
        trust: {
          level: "external-git",
          external: true,
          source: declaredSource,
          resolvedCommit,
        },
        securityScan: {
          complete: true,
          blockingFindings: 0,
        },
      });
      expect(String(activated?.structuredContent?.content)).toContain("Review the requested changes and run focused tests.");
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    }
  }, 20_000);
});
