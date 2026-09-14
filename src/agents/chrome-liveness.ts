import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserTargetProbe } from "./browser-recovery.js";

interface ChromeTargetListEntry {
  id?: string;
  type?: string;
}

function targetIdFromHandle(handle: string | undefined): string | null {
  if (!handle?.startsWith("cdp:")) return null;
  const targetId = handle.slice("cdp:".length).trim();
  return targetId || null;
}

async function activeDevToolsPort(profileDir: string): Promise<number | null> {
  try {
    const text = await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
    const port = Number.parseInt(text.trim().split(/\r?\n/, 1)[0] ?? "", 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/** Probe an existing dedicated Chrome profile without starting/restarting Chrome. */
export function createChromeBrowserTargetProbe(stateDir: string): BrowserTargetProbe {
  const profileDir = path.join(stateDir, "agents", "chrome-worker-profile");
  return {
    async isAlive(browserHandle) {
      const targetId = targetIdFromHandle(browserHandle);
      if (!targetId) return false;
      const port = await activeDevToolsPort(profileDir);
      if (!port) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (!response.ok) return false;
        const targets = (await response.json()) as ChromeTargetListEntry[];
        return targets.some((target) => target.id === targetId && (target.type === undefined || target.type === "page"));
      } catch {
        return false;
      }
    },
  };
}
