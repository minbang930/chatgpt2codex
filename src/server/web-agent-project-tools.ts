import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import {
  clearChatGptProjectMapping,
  getChatGptProjectMapping,
  setChatGptProjectMapping,
} from "../agents/browser-controller.js";
import { addToolCallProof } from "./tool-proof.js";
import { resolveActiveProject } from "../workspace/active.js";
import { requireProjectLease } from "../workspace/lease-guard.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const localState = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const securitySchemes = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;

function meta(invoking: string, invoked: string) {
  return {
    securitySchemes,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

async function activeProject(ctx: ToolContext, write: boolean) {
  const active = await resolveActiveProject(ctx);
  if (!active) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "No active project; call project_select first");
  }
  if (write) await requireProjectLease(ctx, active.projectId, "write");
  return active;
}

function ok(tool: string, result: ReturnType<typeof makeResult>) {
  return { ...result, structuredContent: addToolCallProof(result.structuredContent, tool, result.isError !== true) };
}

function failed(tool: string, error: unknown) {
  const domain = error instanceof DomainError
    ? error
    : new DomainError(ErrorCode.NOT_IMPLEMENTED, error instanceof Error ? error.message : String(error));
  return ok(tool, makeResult({ error: domain.message, code: domain.code }, `Error [${domain.code}]: ${domain.message}`, true));
}

export function registerWebAgentProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "agent_project_route_set",
    {
      title: "Set ChatGPT Project worker route",
      description:
        "Persist the ChatGPT Project URL used for future Web workers of the active local project. This affects browser placement only, not worker permissions.",
      annotations: localState,
      _meta: meta("Saving worker project route...", "Worker project route saved"),
      inputSchema: { url: z.string().url(), label: z.string().min(1).max(200).optional() },
    },
    async (input) => {
      try {
        const active = await activeProject(ctx, true);
        const mapping = await setChatGptProjectMapping(ctx.stateDir, active.projectId, {
          url: input.url,
          label: input.label,
        });
        return ok(
          "agent_project_route_set",
          makeResult(
            { projectId: active.projectId, projectUrl: mapping.projectRef.url, label: mapping.projectRef.label },
            `Future workers for ${active.name} will prefer the configured ChatGPT Project.`,
          ),
        );
      } catch (error) {
        return failed("agent_project_route_set", error);
      }
    },
  );

  server.registerTool(
    "agent_project_route_get",
    {
      title: "Get ChatGPT Project worker route",
      description: "Read the optional ChatGPT Project route for the active local project.",
      annotations: readOnly,
      _meta: meta("Reading worker project route...", "Worker project route loaded"),
      inputSchema: {},
    },
    async () => {
      try {
        const active = await activeProject(ctx, false);
        const mapping = await getChatGptProjectMapping(ctx.stateDir, active.projectId);
        return ok(
          "agent_project_route_get",
          makeResult(
            {
              projectId: active.projectId,
              configured: mapping !== null,
              projectUrl: mapping?.projectRef.url,
              label: mapping?.projectRef.label,
            },
            mapping
              ? `Workers for ${active.name} are routed to the configured ChatGPT Project.`
              : `Workers for ${active.name} use standalone ChatGPT chats.`,
          ),
        );
      } catch (error) {
        return failed("agent_project_route_get", error);
      }
    },
  );

  server.registerTool(
    "agent_project_route_clear",
    {
      title: "Clear ChatGPT Project worker route",
      description: "Remove the ChatGPT Project route for the active local project so future workers use standalone chats.",
      annotations: localState,
      _meta: meta("Clearing worker project route...", "Worker project route cleared"),
      inputSchema: {},
    },
    async () => {
      try {
        const active = await activeProject(ctx, true);
        const cleared = await clearChatGptProjectMapping(ctx.stateDir, active.projectId);
        return ok(
          "agent_project_route_clear",
          makeResult(
            { projectId: active.projectId, cleared },
            cleared
              ? `ChatGPT Project routing cleared for ${active.name}.`
              : `No ChatGPT Project routing was configured for ${active.name}.`,
          ),
        );
      } catch (error) {
        return failed("agent_project_route_clear", error);
      }
    },
  );
}
