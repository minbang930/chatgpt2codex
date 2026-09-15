import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { registerSkillTools } from "./skill-tools.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(dir: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Agent Skills MCP tools", () => {
  it("installs, activates, lists, views, updates, deactivates, and removes a local skill", async () => {
    const workspace = await temp("chatgpt2codex-skill-tools-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-tools-state-");
    const source = path.join(workspace, "skill-source");
    await writeSkill(source, "reviewer", "Review code carefully", "First revision.");

    const server = new McpServer({ name: "skill-tools-test", version: "1" });
    registerSkillTools(server, ctx(workspace, stateDir));
    const tool = handlers(server);

    const installed = await tool.skill_install?.({ source, scope: "global" });
    expect(installed?.isError).not.toBe(true);
    expect(installed?.structuredContent).toMatchObject({
      name: "reviewer",
      scope: "global",
      sourceKind: "local",
    });

    const listed = await tool.skill_list?.({});
    expect(listed?.isError).not.toBe(true);
    expect(listed?.structuredContent?.skills).toEqual([
      expect.objectContaining({
        name: "reviewer",
        description: "Review code carefully",
        scope: "global",
        managed: true,
        active: false,
      }),
    ]);
    expect(JSON.stringify(listed?.structuredContent)).not.toContain("First revision.");

    const activated = await tool.skill_activate?.({ name: "reviewer", activationScope: "global" });
    expect(activated?.isError).not.toBe(true);
    expect(activated?.structuredContent).toMatchObject({
      name: "reviewer",
      activationScope: "global",
      activeSkillNames: ["reviewer"],
    });
    expect(activated?.structuredContent?.content).toContain("First revision.");

    const listedActive = await tool.skill_list?.({});
    expect(listedActive?.structuredContent?.skills).toEqual([
      expect.objectContaining({
        name: "reviewer",
        active: true,
        activationScopes: ["global"],
      }),
    ]);

    const viewed = await tool.skill_view?.({ name: "reviewer" });
    expect(viewed?.isError).not.toBe(true);
    expect(viewed?.structuredContent?.content).toContain("First revision.");

    await writeSkill(source, "reviewer", "Review code carefully", "Second revision.");
    const updated = await tool.skill_update?.({ name: "reviewer", scope: "global" });
    expect(updated?.isError).not.toBe(true);
    const viewedAgain = await tool.skill_view?.({ name: "reviewer" });
    expect(viewedAgain?.structuredContent?.content).toContain("Second revision.");

    const deactivated = await tool.skill_deactivate?.({ name: "reviewer", activationScope: "global" });
    expect(deactivated?.isError).not.toBe(true);
    expect(deactivated?.structuredContent?.activeSkillNames).toEqual([]);

    const removed = await tool.skill_remove?.({ name: "reviewer", scope: "global" });
    expect(removed?.isError).not.toBe(true);
    const after = await tool.skill_list?.({});
    expect(after?.structuredContent?.skills).toEqual([]);
  });

  it("rejects activating a skill whose full instructions exceed the activation budget", async () => {
    const workspace = await temp("chatgpt2codex-skill-tools-large-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-tools-large-state-");
    const source = path.join(workspace, "large-skill");
    await writeSkill(source, "large-reviewer", "Large review skill", "x".repeat(8_100));

    const server = new McpServer({ name: "skill-tools-large-test", version: "1" });
    registerSkillTools(server, ctx(workspace, stateDir));
    const tool = handlers(server);
    expect((await tool.skill_install?.({ source, scope: "global" }))?.isError).not.toBe(true);

    const activated = await tool.skill_activate?.({ name: "large-reviewer", activationScope: "global" });
    expect(activated?.isError).toBe(true);
    expect(String(activated?.structuredContent?.error)).toMatch(/activation.*8000|8000.*activation/i);
    expect(String(activated?.structuredContent?.error)).toMatch(/skill_view/i);
  });

  it("does not expose a local source outside the workspace through skill_install", async () => {
    const workspace = await temp("chatgpt2codex-skill-tools-safe-workspace-");
    const stateDir = await temp("chatgpt2codex-skill-tools-safe-state-");
    const outside = await temp("chatgpt2codex-skill-tools-outside-");
    await writeSkill(outside, "outside", "Outside skill", "nope");

    const server = new McpServer({ name: "skill-tools-safe-test", version: "1" });
    registerSkillTools(server, ctx(workspace, stateDir));
    const result = await handlers(server).skill_install?.({ source: outside, scope: "global" });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.error).toMatch(/inside the configured workspace root/i);
  });
});
