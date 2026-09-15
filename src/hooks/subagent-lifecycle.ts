import { Ledger } from "../state/ledger.js";
import { HookEngine, type HookDispatchReport } from "./engine.js";

export type SubagentFinalStatus = "completed" | "failed" | "cancelled";

export interface SubagentLifecycleWorker {
  workerId: string;
  projectId: string;
  status: "pending" | "running" | SubagentFinalStatus;
  workspace?: {
    worktreePath: string;
  };
}

const engines = new Map<string, HookEngine>();

function engineForStateDir(stateDir: string): HookEngine {
  let engine = engines.get(stateDir);
  if (!engine) {
    engine = new HookEngine(stateDir);
    engines.set(stateDir, engine);
  }
  return engine;
}

async function audit(stateDir: string, report: HookDispatchReport, workerId: string): Promise<void> {
  const failed = report.results.filter((result) => result.status === "failed").length;
  const timedOut = report.results.filter((result) => result.status === "timed_out").length;
  try {
    await new Ledger(stateDir).append({
      type: "hook.dispatch",
      event: report.event,
      workerId,
      configured: report.configured,
      executed: report.executed,
      failed,
      timedOut,
      configError: report.configError !== undefined,
      durationMs: report.durationMs,
    });
  } catch {
    // Lifecycle hooks and their observability are notifications only.
  }
}

async function emit(
  stateDir: string,
  event: "SubagentStart" | "SubagentStop",
  worker: SubagentLifecycleWorker,
): Promise<void> {
  try {
    const workerRoot = worker.workspace?.worktreePath;
    const report = await engineForStateDir(stateDir).emit(
      event,
      {
        workerId: worker.workerId,
        projectId: worker.projectId,
        status: worker.status,
      },
      {
        workspaceRoot: workerRoot ?? stateDir,
        ...(workerRoot ? { projectRoot: workerRoot } : {}),
      },
    );
    await audit(stateDir, report, worker.workerId);
  } catch {
    try {
      await new Ledger(stateDir).append({
        type: "hook.dispatch.unexpected_error",
        event,
        workerId: worker.workerId,
      });
    } catch {
      // Durable worker state has already transitioned; never roll it back.
    }
  }
}

/** Emit only after the durable pending -> running transition has been saved. */
export async function emitSubagentStartHook(
  stateDir: string,
  worker: SubagentLifecycleWorker,
): Promise<void> {
  await emit(stateDir, "SubagentStart", worker);
}

/** Emit only after a durable final worker state has been saved. */
export async function emitSubagentStopHook(
  stateDir: string,
  worker: SubagentLifecycleWorker & { status: SubagentFinalStatus },
): Promise<void> {
  await emit(stateDir, "SubagentStop", worker);
}
