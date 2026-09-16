import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  WORKER_EXECUTION_FALLBACK_POLICIES,
  WORKER_REASONING_EFFORTS,
  clearWorkerExecutionPreference,
  getWorkerExecutionSettingsSnapshot,
  resolveWorkerExecutionIntent,
  setWorkerExecutionPreference,
  type WorkerExecutionPreference,
  type WorkerExecutionSettingsScope,
} from "../agents/execution-settings.js";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import { resolveActiveProject } from "../workspace/active.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { addToolCallProof } from "./tool-proof.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const LOCAL_STATE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;

function meta(invoking: string, invoked: string) {
  return {
    securitySchemes: SECURITY_SCHEMES,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

function ok(tool: string, result: ReturnType<typeof makeResult>) {
  return {
    ...result,
    structuredContent: addToolCallProof(result.structuredContent, tool, result.isError !== true),
  };
}

function failed(tool: string, error: unknown) {
  const domain =
    error instanceof DomainError
      ? error
      : new DomainError(ErrorCode.NOT_IMPLEMENTED, error instanceof Error ? error.message : String(error));
  return ok(
    tool,
    makeResult(
      { error: domain.message, code: domain.code },
      `Error [${domain.code}]: ${domain.message}`,
      true,
    ),
  );
}

async function requireActiveProject(ctx: ToolContext, requireWorkerAuthority: boolean) {
  const active = await resolveActiveProject(ctx);
  if (!active) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "No active project; call project_select first");
  }
  if (requireWorkerAuthority) {
    await requireProjectLease(ctx, active.projectId, "worker");
  }
  return active;
}

async function viewSettings(ctx: ToolContext, scope: WorkerExecutionSettingsScope) {
  if (scope === "global") {
    const snapshot = await getWorkerExecutionSettingsSnapshot(ctx.stateDir);
    const intent = resolveWorkerExecutionIntent({ global: snapshot.global });
    return {
      scope,
      configured: snapshot.global !== undefined,
      preference: snapshot.global,
      effective: intent.resolved,
      sources: intent.sources,
    };
  }

  const active = await requireActiveProject(ctx, false);
  const snapshot = await getWorkerExecutionSettingsSnapshot(ctx.stateDir, active.projectId);
  const intent = resolveWorkerExecutionIntent({ global: snapshot.global, project: snapshot.project });
  return {
    scope,
    projectId: active.projectId,
    configured: snapshot.project !== undefined,
    preference: snapshot.project,
    global: snapshot.global,
    effective: intent.resolved,
    sources: intent.sources,
  };
}

function preferenceFromInput(input: {
  model?: string;
  reasoningEffort?: (typeof WORKER_REASONING_EFFORTS)[number];
  fallbackPolicy?: (typeof WORKER_EXECUTION_FALLBACK_POLICIES)[number];
}): WorkerExecutionPreference {
  return {
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.fallbackPolicy !== undefined ? { fallbackPolicy: input.fallbackPolicy } : {}),
  };
}

export function registerWorkerExecutionSettingsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "worker_execution_settings_get",
    {
      title: "Get worker execution settings",
      description:
        "Read normalized worker model/reasoning defaults for the global runtime or active local project. Project output also shows the effective project-over-global resolution. This does not inspect ChatGPT Web UI state.",
      annotations: READ_ONLY,
      _meta: meta("Reading worker execution settings...", "Worker execution settings loaded"),
      inputSchema: {
        scope: z.enum(["global", "project"]),
      },
    },
    async (input) => {
      try {
        const view = await viewSettings(ctx, input.scope);
        return ok(
          "worker_execution_settings_get",
          makeResult(
            view,
            view.configured
              ? `Worker execution settings are configured for ${input.scope} scope.`
              : `No worker execution settings are configured for ${input.scope} scope.`,
          ),
        );
      } catch (error) {
        return failed("worker_execution_settings_get", error);
      }
    },
  );

  server.registerTool(
    "worker_execution_settings_set",
    {
      title: "Set worker execution settings",
      description:
        "Replace the normalized worker execution preference for global or active-project scope. Mutations require the active project's worker-orchestration lease capability; global scope uses the same existing authority boundary rather than introducing a new authorization path.",
      annotations: LOCAL_STATE,
      _meta: meta("Saving worker execution settings...", "Worker execution settings saved"),
      inputSchema: {
        scope: z.enum(["global", "project"]),
        model: z.string().max(200).optional(),
        reasoningEffort: z.enum(WORKER_REASONING_EFFORTS).optional(),
        fallbackPolicy: z.enum(WORKER_EXECUTION_FALLBACK_POLICIES).optional(),
      },
    },
    async (input) => {
      try {
        const active = await requireActiveProject(ctx, true);
        const preference = preferenceFromInput(input);
        await setWorkerExecutionPreference(
          ctx.stateDir,
          input.scope,
          preference,
          input.scope === "project" ? active.projectId : undefined,
        );
        const view = await viewSettings(ctx, input.scope);
        return ok(
          "worker_execution_settings_set",
          makeResult(
            view,
            `Worker execution settings saved for ${input.scope} scope. Existing durable workers are unchanged.`,
          ),
        );
      } catch (error) {
        return failed("worker_execution_settings_set", error);
      }
    },
  );

  server.registerTool(
    "worker_execution_settings_clear",
    {
      title: "Clear worker execution settings",
      description:
        "Clear the global or active-project worker execution preference. Mutations require the active project's worker-orchestration lease capability. Existing durable workers are not modified.",
      annotations: LOCAL_STATE,
      _meta: meta("Clearing worker execution settings...", "Worker execution settings cleared"),
      inputSchema: {
        scope: z.enum(["global", "project"]),
      },
    },
    async (input) => {
      try {
        const active = await requireActiveProject(ctx, true);
        const cleared = await clearWorkerExecutionPreference(
          ctx.stateDir,
          input.scope,
          input.scope === "project" ? active.projectId : undefined,
        );
        const view = await viewSettings(ctx, input.scope);
        return ok(
          "worker_execution_settings_clear",
          makeResult(
            { ...view, cleared },
            cleared
              ? `Worker execution settings cleared for ${input.scope} scope.`
              : `No worker execution settings were configured for ${input.scope} scope.`,
          ),
        );
      } catch (error) {
        return failed("worker_execution_settings_clear", error);
      }
    },
  );
}
