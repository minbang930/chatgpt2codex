import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { globalSkillsDir } from "../skills/registry.js";
import { registerSkillSecurityTools } from "./skill-security-tools.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function ctx(workspaceRoot: string, stateDir: string): ToolContext {
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
  };
}

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function handlers(server: McpServer): Record<string, Handler> {
  return Object.fromEntries(
    Object.entries(
      (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {},
    ).flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

async function writeSkill(stateDir: string): Promise<void> {
  const skillDir = path.join(globalSkillsDir(stateDir), "reviewer");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: reviewer\ndescription: Review helper\n---\n\nReview the requested changes.\n",
    "utf8",
  );
  await writeFile(path.join(skillDir, "references", "guide.md"), "Reference details.\n", "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Agent Skill security MCP tools", () => {
  it("reports trust metadata without returning the instruction body", async () => {
    const workspace = await temp("chatgpt2codex-skill-security-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-security-state-");
    await writeSkill(stateDir);
    const server = new McpServer({ name: "skill-security-test", version: "1" });
    registerSkillSecurityTools(server, ctx(workspace, stateDir));

    const inspected = await handlers(server).skill_security_status?.({ name: "reviewer" });
    expect(inspected?.isError).not.toBe(true);
    expect(inspected?.structuredContent).toMatchObject({
      name: "reviewer",
      trust: { level: "unmanaged", managed: false, external: false },
      securityScan: { complete: true, blockingFindings: 0 },
    });
    expect(JSON.stringify(inspected?.structuredContent)).not.toContain("Review the requested changes");
  });

  it("reads a bounded allowed resource and rejects a non-resource path", async () => {
    const workspace = await temp("chatgpt2codex-skill-resource-tool-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-resource-tool-state-");
    await writeSkill(stateDir);
    const server = new McpServer({ name: "skill-resource-test", version: "1" });
    registerSkillSecurityTools(server, ctx(workspace, stateDir));
    const tool = handlers(server);

    const read = await tool.skill_resource_read?.({ name: "reviewer", path: "references/guide.md" });
    expect(read?.isError).not.toBe(true);
    expect(read?.structuredContent).toMatchObject({
      name: "reviewer",
      resource: { path: "references/guide.md", encoding: "utf8", content: "Reference details.\n" },
    });

    const rejected = await tool.skill_resource_read?.({ name: "reviewer", path: "SKILL.md" });
    expect(rejected?.isError).toBe(true);
  });
});
