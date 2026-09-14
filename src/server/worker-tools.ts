import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext, type ToolResult } from "../types.js";
import { dispatchWorkerCoreTool, WORKER_CORE_TOOL_NAMES } from "../agents/dispatcher.js";
import { addToolCallProof } from "./tool-proof.js";
import { redact } from "../policy/secrets.js";

interface RegisteredCoreTool {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
  _meta?: Record<string, unknown>;
}

interface CallToolResultLike {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

function workerInputSchema(schema: unknown): z.ZodObject<z.ZodRawShape> {
  if (!(schema instanceof z.ZodObject)) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Worker Core source tool does not have an object input schema");
  }
  // The project is derived from the authenticated worker capability. Never
  // accept caller-selected project routing on the worker surface.
  return schema.omit({ projectId: true }).extend({
    workerToken: z.string().min(1).describe("Opaque worker capability issued by the local runtime"),
  });
}

function errorResult(toolName: string, err: unknown): CallToolResultLike {
  const code = err instanceof DomainError ? err.code : ErrorCode.NOT_IMPLEMENTED;
  const message = redact(err instanceof Error ? err.message : String(err));
  const result: ToolResult<Record<string, unknown>> = makeResult(
    { error: message, code },
    `Error [${code}]: ${message}`,
    true,
  );
  return {
    content: result.content,
    structuredContent: addToolCallProof(result.structuredContent, toolName, false),
    isError: true,
  };
}

/**
 * Register explicit worker-prefixed mirrors of the small Core allowlist.
 * Schemas/descriptions/annotations come from the already-registered Core
 * tools, while projectId is removed and an opaque workerToken is required.
 */
export function registerWorkerTools(server: McpServer, ctx: ToolContext): void {
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredCoreTool> })._registeredTools;
  if (!tools) return;

  for (const coreName of WORKER_CORE_TOOL_NAMES) {
    const source = tools[coreName];
    if (!source) {
      throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Cannot expose missing worker Core tool: ${coreName}`);
    }
    const publicName = `worker_${coreName}`;
    const inputSchema = workerInputSchema(source.inputSchema);

    server.registerTool(
      publicName,
      {
        title: `Worker: ${source.title ?? coreName}`,
        description:
          `Worker-scoped ${coreName}. Operates only inside the isolated worktree bound to workerToken; project selection is not accepted. ${source.description ?? ""}`.trim(),
        inputSchema,
        ...(source.outputSchema ? { outputSchema: source.outputSchema } : {}),
        ...(source.annotations ? { annotations: source.annotations as never } : {}),
        ...(source.execution ? { execution: source.execution as never } : {}),
        _meta: {
          ...(source._meta ?? {}),
          "openai/toolInvocation/invoking": `Running worker ${coreName}...`,
          "openai/toolInvocation/invoked": `Worker ${coreName} finished`,
        },
      } as never,
      async (input) => {
        const raw = input as Record<string, unknown>;
        const workerToken = String(raw.workerToken ?? "");
        const { workerToken: _secret, projectId: _ignored, ...coreInput } = raw;
        try {
          const result = await dispatchWorkerCoreTool(ctx, workerToken, coreName, coreInput);
          return {
            ...result,
            structuredContent: addToolCallProof(result.structuredContent ?? {}, publicName, result.isError !== true),
          } as never;
        } catch (err) {
          return errorResult(publicName, err) as never;
        }
      },
    );
  }
}
