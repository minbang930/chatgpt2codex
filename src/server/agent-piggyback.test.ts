import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeWorker, createWorker, getWorker } from "../agents/store.js";
import type { ToolContext } from "../types.js";
import { createServer } from "./mcp-server.js";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-piggyback-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(stateDir: string): ToolContext {
  return {
    workspaceRoot: path.dirname(stateDir),
    stateDir,
    registry: [],
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: path.dirname(stateDir),
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

type ToolResponse = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResponse>;

function handlers(server: Awaited<ReturnType<typeof createServer>>): Record<string, ToolHandler> {
  return Object.fromEntries(
    Object.entries(
      (server as unknown as { _registeredTools?: Record<string, { handler?: ToolHandler }> })._registeredTools ?? {},
    ).flatMap(([name, tool]) => (tool.handler ? [[name, tool.handler] as const] : [])),
  );
}

async function completedWorker(stateDir: string, n = 1) {
  const worker = await createWorker(stateDir, {
    projectId: "project-1",
    task: `worker task ${n}`,
  });
  return completeWorker(stateDir, worker.workerId, {
    summary: `worker ${n} finished`,
    changedFiles: [`file-${n}.ts`],
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker completion piggyback", () => {
  it("attaches one concise update to the next Core result, acknowledges it once, and keeps the full result durable", async () => {
    const stateDir = await makeStateDir();
    const completed = await completedWorker(stateDir);
    const server = await createServer(makeCtx(stateDir));
    const tool = handlers(server);

    // Explicit agent tools are registered after the Core wrapper and should not
    // accidentally consume the pending notification.
    const status = await tool.agent_status?.({ workerId: completed.workerId });
    expect(status?.structuredContent?.agentUpdates).toBeUndefined();

    const firstCore = await tool.agent_guide?.({});
    expect(firstCore?.structuredContent?.agentUpdates).toEqual([
      {
        workerId: completed.workerId,
        status: "completed",
        eventId: completed.notification?.eventId,
      },
    ]);
    expect(firstCore?.content?.at(-1)?.text).toContain("Agent updates:");
    expect(firstCore?.content?.at(-1)?.text).toContain(completed.workerId);
    expect(firstCore?.content?.at(-1)?.text).not.toContain("worker 1 finished");

    const afterDelivery = await getWorker(stateDir, completed.workerId);
    expect(afterDelivery?.notification?.notifiedAt).toEqual(expect.any(Number));
    expect(afterDelivery?.result?.summary).toBe("worker 1 finished");

    const secondCore = await tool.agent_guide?.({});
    expect(secondCore?.structuredContent?.agentUpdates).toBeUndefined();

    const result = await tool.agent_result?.({ workerId: completed.workerId });
    expect((result?.structuredContent?.result as { summary?: string } | undefined)?.summary).toBe("worker 1 finished");
  });

  it("keeps each Core response bounded and leaves excess events for later calls", async () => {
    const stateDir = await makeStateDir();
    const workers = [];
    for (let i = 1; i <= 6; i += 1) {
      workers.push(await completedWorker(stateDir, i));
    }
    const server = await createServer(makeCtx(stateDir));
    const tool = handlers(server);

    const first = await tool.agent_guide?.({});
    const firstUpdates = first?.structuredContent?.agentUpdates as Array<{ workerId: string }> | undefined;
    expect(firstUpdates).toHaveLength(5);
    expect(first?.structuredContent?.moreAgentUpdatesPending).toBe(true);

    const sixthBefore = await getWorker(stateDir, workers[5]!.workerId);
    expect(sixthBefore?.notification?.notifiedAt).toBeUndefined();

    const second = await tool.agent_guide?.({});
    const secondUpdates = second?.structuredContent?.agentUpdates as Array<{ workerId: string }> | undefined;
    expect(secondUpdates).toEqual([{ workerId: workers[5]!.workerId, status: "completed", eventId: workers[5]!.notification?.eventId }]);
    expect(second?.structuredContent?.moreAgentUpdatesPending).toBeUndefined();

    const third = await tool.agent_guide?.({});
    expect(third?.structuredContent?.agentUpdates).toBeUndefined();
  });
});
