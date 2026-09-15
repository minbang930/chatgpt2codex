import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginRegistry, registerPlugin, removePlugin, setPluginEnabled } from "./registry.js";

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
    expect((await readPluginRegistry(stateDir)).plugins).toHaveLength(1);
    expect((await setPluginEnabled({ stateDir, id: "docs", enabled: true })).enabled).toBe(true);
    expect(await removePlugin(stateDir, "docs")).toBe(true);
    expect((await readPluginRegistry(stateDir)).plugins).toHaveLength(0);
  });
});
