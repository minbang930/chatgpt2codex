import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listUnnotifiedWorkerEvents,
  markWorkerEventNotified,
  type WorkerFinalStatus,
} from "./store.js";

const MAX_UPDATES_PER_RESULT = 5;

export interface AgentUpdateNotice {
  workerId: string;
  status: WorkerFinalStatus;
  eventId: string;
}

interface CallToolResultLike {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RegisteredToolLike {
  handler?: (...args: unknown[]) => Promise<CallToolResultLike>;
}

function noticeText(updates: AgentUpdateNotice[], hasMore: boolean): string {
  const lines = updates.map((update) => `- ${update.workerId}: ${update.status}`);
  if (hasMore) lines.push("- More worker updates are pending for a later tool result.");
  lines.push("Use agent_result with a worker ID to retrieve its durable full result.");
  return `Agent updates:\n${lines.join("\n")}`;
}

/**
 * Attach a bounded batch of durable worker completion notices to one normal
 * Core MCP result. Notification handling is deliberately best-effort: a broken
 * inbox must never make an otherwise-successful Core file/shell/git call fail.
 *
 * Full worker results are never embedded here and remain durable behind
 * `agent_result`. Only events that are actually attached are marked notified.
 */
export async function appendAgentUpdates(
  stateDir: string,
  result: CallToolResultLike,
): Promise<CallToolResultLike> {
  try {
    const pending = await listUnnotifiedWorkerEvents(stateDir);
    if (pending.length === 0) return result;

    const selected = pending.slice(0, MAX_UPDATES_PER_RESULT);
    const updates: AgentUpdateNotice[] = selected.map(({ worker, notification }) => ({
      workerId: worker.workerId,
      status: notification.status,
      eventId: notification.eventId,
    }));
    const hasMore = pending.length > selected.length;

    const next: CallToolResultLike = {
      ...result,
      structuredContent: {
        ...(result.structuredContent ?? {}),
        agentUpdates: updates,
        ...(hasMore ? { moreAgentUpdatesPending: true } : {}),
      },
      content: [
        ...(Array.isArray(result.content) ? result.content : []),
        { type: "text", text: noticeText(updates, hasMore) },
      ],
    };

    // Consume only notices placed in this response. If acknowledgement fails,
    // leave the event pending so a later call may repeat the notice rather than
    // silently lose it.
    for (const { notification } of selected) {
      await markWorkerEventNotified(stateDir, notification.eventId).catch(() => null);
    }

    return next;
  } catch {
    return result;
  }
}

/**
 * Wrap the tools already registered on an McpServer. Call this immediately
 * after Core `registerTools` and before registering agent tools so only normal
 * Core results receive piggyback notices; explicit agent_* calls keep their
 * focused result semantics.
 */
export function installAgentNotificationPiggyback(server: McpServer, stateDir: string): void {
  const registeredTools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  if (!registeredTools) return;

  for (const tool of Object.values(registeredTools)) {
    const original = tool.handler;
    if (!original) continue;
    tool.handler = async (...args: unknown[]) => appendAgentUpdates(stateDir, await original(...args));
  }
}
