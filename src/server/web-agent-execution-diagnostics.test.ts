import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BrowserWorkerController,
  type BrowserWorkerDriver,
} from "../agents/browser-controller.js";
import { completeWorker, createWorker } from "../agents/store.js";
import { DomainError, ErrorCode, type ToolContext } from "../types.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerWebAgentTools } from "./web-agent-tools.js";

const tempDirs: string[] = [];

type Handler = (input: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

async function makeCtx(): Promise<ToolContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-execution-diagnostics-"));
  tempDirs.push(stateDir);
  const root = path.join(stateDir, "project");
  const registry = [{ projectId: "project-execution-diagnostics", name: "diagnostics", root, aliases: [] }];
  return {
    workspaceRoot: stateDir,
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => ({ activeProjectId: registry[0]!.projectId, mode: "read", lease: null }),
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: stateDir,
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

function handler(server: McpServer, name: string): Handler {
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: Handler }> })._registeredTools ?? {};
  const found = tools[name]?.handler;
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function installTools(ctx: ToolContext, driver: BrowserWorkerDriver): McpServer {
  const server = new McpServer({ name: "execution-diagnostics-test", version: "1" });
  registerAgentTools(server, ctx);
  registerWebAgentTools(server, ctx, {
    browserDriver: driver,
    browserProbe: { isAlive: async () => true },
  });
  return server;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("M6.4 worker execution diagnostics", () => {
  it("surfaces durable requested/resolved intent beside the current browser observation", async () => {
    const ctx = await makeCtx();
    const executionIntent = {
      requested: { model: "GPT-5.6 Sol", reasoningEffort: "high" as const },
      resolved: {
        model: "GPT-5.6 Sol",
        reasoningEffort: "high" as const,
        fallbackPolicy: "fail-closed" as const,
      },
      sources: {
        model: "worker" as const,
        reasoningEffort: "worker" as const,
        fallbackPolicy: "default" as const,
      },
    };
    const worker = await createWorker(ctx.stateDir, {
      projectId: ctx.registry[0]!.projectId,
      task: "Report execution diagnostics",
      executionIntent,
    });
    const driver: BrowserWorkerDriver = {
      launch: async () => ({
        browserHandle: "fake:execution-diagnostics",
        execution: {
          verified: true,
          observedModel: "GPT-5.6 Sol",
          observedReasoningEffort: "high",
        },
      }),
      cancel: async () => undefined,
    };
    await new BrowserWorkerController(ctx.stateDir, driver).launch({
      workerId: worker.workerId,
      projectId: worker.projectId,
      task: worker.task,
      workerToken: "fake-token",
      executionIntent,
    });

    const server = installTools(ctx, driver);
    const status = await handler(server, "agent_status")({ workerId: worker.workerId });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      workerId: worker.workerId,
      execution: {
        requested: { model: "GPT-5.6 Sol", reasoningEffort: "high" },
        resolved: {
          model: "GPT-5.6 Sol",
          reasoningEffort: "high",
          fallbackPolicy: "fail-closed",
        },
        observed: { model: "GPT-5.6 Sol", reasoningEffort: "high" },
        verified: true,
        attempt: 1,
      },
    });

    await completeWorker(ctx.stateDir, worker.workerId, { summary: "done" });
    const result = await handler(server, "agent_result")({ workerId: worker.workerId });
    expect(result.structuredContent).toMatchObject({
      status: "completed",
      execution: {
        resolved: { model: "GPT-5.6 Sol", reasoningEffort: "high" },
        observed: { model: "GPT-5.6 Sol", reasoningEffort: "high" },
        verified: true,
        attempt: 1,
      },
    });
  });

  it("persists a failed verification diagnostic without turning it into a durable worker failure", async () => {
    const ctx = await makeCtx();
    const executionIntent = {
      resolved: {
        reasoningEffort: "extra-high" as const,
        fallbackPolicy: "fail-closed" as const,
      },
    };
    const worker = await createWorker(ctx.stateDir, {
      projectId: ctx.registry[0]!.projectId,
      task: "Fail execution verification",
      executionIntent,
    });
    const driver: BrowserWorkerDriver = {
      launch: async () => {
        throw new DomainError(
          ErrorCode.WORKSPACE_NOT_READY,
          "ChatGPT reasoning effort is unavailable",
          {
            workerExecution: {
              verified: false,
              observedReasoningEffort: "high",
              error: "ChatGPT reasoning effort is unavailable",
            },
          },
        );
      },
      cancel: async () => undefined,
    };
    await expect(new BrowserWorkerController(ctx.stateDir, driver).launch({
      workerId: worker.workerId,
      projectId: worker.projectId,
      task: worker.task,
      workerToken: "fake-token",
      executionIntent,
    })).rejects.toThrow(/unavailable/i);

    const server = installTools(ctx, driver);
    const status = await handler(server, "agent_status")({ workerId: worker.workerId });
    expect(status.structuredContent).toMatchObject({
      status: "pending",
      browser: { status: "failed", attempt: 1, recoverable: false },
      execution: {
        resolved: { reasoningEffort: "extra-high", fallbackPolicy: "fail-closed" },
        observed: { reasoningEffort: "high" },
        verified: false,
        error: "ChatGPT reasoning effort is unavailable",
        attempt: 1,
      },
    });
  });

  it("keeps unmanaged workers concise and reports the newest recovery attempt", async () => {
    const ctx = await makeCtx();
    const unmanaged = await createWorker(ctx.stateDir, {
      projectId: ctx.registry[0]!.projectId,
      task: "Stay unmanaged",
    });
    const unmanagedDriver: BrowserWorkerDriver = {
      launch: async () => ({ browserHandle: "fake:unmanaged" }),
      cancel: async () => undefined,
    };
    await new BrowserWorkerController(ctx.stateDir, unmanagedDriver).launch({
      workerId: unmanaged.workerId,
      projectId: unmanaged.projectId,
      task: unmanaged.task,
      workerToken: "fake-token",
    });
    const unmanagedStatus = await handler(installTools(ctx, unmanagedDriver), "agent_status")({ workerId: unmanaged.workerId });
    expect(unmanagedStatus.structuredContent).not.toHaveProperty("execution");

    const executionIntent = {
      resolved: { reasoningEffort: "medium" as const, fallbackPolicy: "allow-current" as const },
    };
    const worker = await createWorker(ctx.stateDir, {
      projectId: ctx.registry[0]!.projectId,
      task: "Refresh execution observation on recovery",
      executionIntent,
    });
    const failedDriver: BrowserWorkerDriver = {
      launch: async () => {
        throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "first attempt failed", {
          workerExecution: {
            verified: false,
            observedReasoningEffort: "instant",
            error: "first attempt failed",
          },
        });
      },
      cancel: async () => undefined,
    };
    const controller = new BrowserWorkerController(ctx.stateDir, failedDriver);
    await expect(controller.launch({
      workerId: worker.workerId,
      projectId: worker.projectId,
      task: worker.task,
      workerToken: "fake-token",
      executionIntent,
    })).rejects.toThrow();

    const recoveredDriver: BrowserWorkerDriver = {
      launch: async () => ({
        browserHandle: "fake:recovered-execution",
        execution: { verified: true, observedReasoningEffort: "medium" },
      }),
      cancel: async () => undefined,
    };
    await new BrowserWorkerController(ctx.stateDir, recoveredDriver).launch({
      workerId: worker.workerId,
      projectId: worker.projectId,
      task: worker.task,
      workerToken: "fake-token-2",
      executionIntent,
    });

    const status = await handler(installTools(ctx, recoveredDriver), "agent_status")({ workerId: worker.workerId });
    expect(status.structuredContent).toMatchObject({
      browser: { attempt: 2, status: "running" },
      execution: {
        resolved: { reasoningEffort: "medium", fallbackPolicy: "allow-current" },
        observed: { reasoningEffort: "medium" },
        verified: true,
        attempt: 2,
      },
    });
  });
});
