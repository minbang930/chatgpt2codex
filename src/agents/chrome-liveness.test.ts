import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChromeBrowserTargetProbe } from "./chrome-liveness.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

async function tempState(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-chrome-live-"));
  tempDirs.push(dir);
  return dir;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Chrome worker target liveness", () => {
  it("returns false without an existing dedicated Chrome endpoint", async () => {
    const stateDir = await tempState();
    const probe = createChromeBrowserTargetProbe(stateDir);
    await expect(probe.isAlive("cdp:missing-target")).resolves.toBe(false);
    await expect(probe.isAlive("not-a-cdp-handle")).resolves.toBe(false);
  });

  it("matches the existing target id without starting Chrome", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/json/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "target-a", type: "page" }, { id: "target-b", type: "page" }]));
        return;
      }
      res.writeHead(404).end();
    });
    const port = await listen(server);
    const stateDir = await tempState();
    const profile = path.join(stateDir, "agents", "chrome-worker-profile");
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "DevToolsActivePort"), `${port}\n/devtools/browser/test\n`, "utf8");

    const probe = createChromeBrowserTargetProbe(stateDir);
    await expect(probe.isAlive("cdp:target-a")).resolves.toBe(true);
    await expect(probe.isAlive("cdp:target-c")).resolves.toBe(false);
  });
});
