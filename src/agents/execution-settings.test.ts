import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../types.js";
import {
  clearWorkerExecutionPreference,
  getWorkerExecutionSettingsSnapshot,
  resolveWorkerExecutionIntent,
  setWorkerExecutionPreference,
} from "./execution-settings.js";

const tempDirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker execution settings", () => {
  it("keeps existing runtimes unmanaged when no settings file exists", async () => {
    const stateDir = await temp("chatgpt2codex-execution-settings-");

    await expect(getWorkerExecutionSettingsSnapshot(stateDir, "project-a")).resolves.toEqual({});
    expect(resolveWorkerExecutionIntent({})).toEqual({});
  });

  it("persists normalized global and project preferences atomically", async () => {
    const stateDir = await temp("chatgpt2codex-execution-settings-");

    await setWorkerExecutionPreference(
      stateDir,
      "global",
      { model: "  GPT-5.6 Sol  ", fallbackPolicy: "allow-current" },
    );
    await setWorkerExecutionPreference(
      stateDir,
      "project",
      { reasoningEffort: "high" },
      " project-a ",
    );

    await expect(getWorkerExecutionSettingsSnapshot(stateDir, "project-a")).resolves.toEqual({
      global: { model: "GPT-5.6 Sol", fallbackPolicy: "allow-current" },
      project: { reasoningEffort: "high" },
    });

    const raw = JSON.parse(
      await readFile(path.join(stateDir, "agents", "worker-execution-settings.json"), "utf8"),
    ) as { version: number; projects: Array<{ projectId: string }> };
    expect(raw.version).toBe(1);
    expect(raw.projects).toEqual([expect.objectContaining({ projectId: "project-a" })]);
  });

  it("resolves precedence per field as worker > project > global", () => {
    expect(
      resolveWorkerExecutionIntent({
        global: {
          model: "global-model",
          reasoningEffort: "medium",
          fallbackPolicy: "allow-current",
        },
        project: { reasoningEffort: "high" },
        worker: { model: "worker-model" },
      }),
    ).toEqual({
      requested: { model: "worker-model" },
      resolved: {
        model: "worker-model",
        reasoningEffort: "high",
        fallbackPolicy: "allow-current",
      },
      sources: {
        model: "worker",
        reasoningEffort: "project",
        fallbackPolicy: "global",
      },
    });
  });

  it("defaults an explicit model or reasoning request to fail-closed", () => {
    expect(
      resolveWorkerExecutionIntent({
        global: { model: "GPT-5.6 Sol" },
        project: { reasoningEffort: "medium" },
      }),
    ).toEqual({
      resolved: {
        model: "GPT-5.6 Sol",
        reasoningEffort: "medium",
        fallbackPolicy: "fail-closed",
      },
      sources: {
        model: "global",
        reasoningEffort: "project",
        fallbackPolicy: "default",
      },
    });
  });

  it("allows a higher-precedence fallback policy without forcing model/reasoning selection", () => {
    expect(
      resolveWorkerExecutionIntent({
        global: { fallbackPolicy: "allow-current" },
      }),
    ).toEqual({
      resolved: { fallbackPolicy: "allow-current" },
      sources: { fallbackPolicy: "global" },
    });
  });

  it("clears scopes independently", async () => {
    const stateDir = await temp("chatgpt2codex-execution-settings-");
    await setWorkerExecutionPreference(stateDir, "global", { reasoningEffort: "medium" });
    await setWorkerExecutionPreference(stateDir, "project", { reasoningEffort: "high" }, "project-a");

    await expect(clearWorkerExecutionPreference(stateDir, "project", "project-a")).resolves.toBe(true);
    await expect(clearWorkerExecutionPreference(stateDir, "project", "project-a")).resolves.toBe(false);
    await expect(getWorkerExecutionSettingsSnapshot(stateDir, "project-a")).resolves.toEqual({
      global: { reasoningEffort: "medium" },
    });

    await expect(clearWorkerExecutionPreference(stateDir, "global")).resolves.toBe(true);
    await expect(getWorkerExecutionSettingsSnapshot(stateDir, "project-a")).resolves.toEqual({});
  });

  it("rejects empty configured preferences", async () => {
    const stateDir = await temp("chatgpt2codex-execution-settings-");

    await expect(setWorkerExecutionPreference(stateDir, "global", {})).rejects.toBeInstanceOf(DomainError);
    await expect(
      setWorkerExecutionPreference(stateDir, "global", { model: "   " }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects invalid persisted enum values instead of silently accepting them", async () => {
    const stateDir = await temp("chatgpt2codex-execution-settings-");
    const agents = path.join(stateDir, "agents");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(agents, { recursive: true }));
    await writeFile(
      path.join(agents, "worker-execution-settings.json"),
      `${JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        global: {
          preference: { reasoningEffort: "ultra" },
          updatedAt: Date.now(),
        },
        projects: [],
      })}\n`,
      "utf8",
    );

    await expect(getWorkerExecutionSettingsSnapshot(stateDir)).rejects.toBeInstanceOf(DomainError);
  });
});
