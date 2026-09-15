import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginRegistry, registerPlugin, removePlugin, setPluginEnabled, summarizePlugin } from "./registry.js";

const dirs: string[] = [];

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "c2c-plugin-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin registry", () => {
  it("supports register, enable, and remove", async () => {
    const stateDir = await makeTemp();
    const created = await registerPlugin({ stateDir, id: "docs", name: "Docs", url: "https://example.org/mcp" });
    expect(created.enabled).toBe(false);
    expect(created.skillSources).toEqual([]);
    expect((await readPluginRegistry(stateDir)).plugins).toHaveLength(1);
    expect((await setPluginEnabled({ stateDir, id: "docs", enabled: true })).enabled).toBe(true);
    expect(await removePlugin(stateDir, "docs")).toBe(true);
    expect((await readPluginRegistry(stateDir)).plugins).toHaveLength(0);
  });

  it("keeps plugin skill sources explicit and inert until normal skill installation is requested", async () => {
    const stateDir = await makeTemp();
    const created = await registerPlugin({
      stateDir,
      id: "docs",
      name: "Docs",
      url: "https://example.org/mcp",
      skillSources: [{
        id: "reviewer",
        source: "https://example.org/skills.git",
        ref: "main",
        skillName: "reviewer",
      }],
    });
    expect(created.skillSources).toEqual([{
      id: "reviewer",
      source: "https://example.org/skills.git",
      ref: "main",
      skillName: "reviewer",
    }]);
    expect(summarizePlugin(created).skillSources).toEqual(created.skillSources);
  });

  it("rejects non-HTTPS and duplicate plugin skill source declarations", async () => {
    const stateDir = await makeTemp();
    await expect(registerPlugin({
      stateDir,
      id: "bad-source",
      name: "Bad source",
      url: "https://example.org/mcp",
      skillSources: [{ id: "skill", source: "http://example.org/skills.git" }],
    })).rejects.toThrow(/must use HTTPS/i);

    await expect(registerPlugin({
      stateDir,
      id: "duplicates",
      name: "Duplicate source",
      url: "https://example.org/mcp",
      skillSources: [
        { id: "skill", source: "https://example.org/one.git" },
        { id: "skill", source: "https://example.org/two.git" },
      ],
    })).rejects.toThrow(/duplicate plugin skill source/i);
  });
});
