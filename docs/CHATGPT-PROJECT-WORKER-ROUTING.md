# ChatGPT Project Worker Routing

This document extends the custom runtime plan for Web worker organization and message-level app routing.

## Goal

Worker chats can be placed dynamically or forced into one ChatGPT Project. Project placement is only for UI organization. Repository authority comes from the dedicated worker MCP app plus the existing worker capability/worktree model.

## Mapping

```text
local repository -> optional ChatGPT Project reference
```

Recommended default: one repository per ChatGPT Project.

M7 adds a Windows EXE-level fixed placement setting and per-worker placement requests. Effective precedence is:

```text
existing durable Worker placement (recovery)
  > fixed EXE Worker Project URL
  > explicit per-worker placement
  > local repository mapping
  > standalone
```

If the EXE setting is blank, callers may request `placement.mode="standalone"` or `placement.mode="project"` with a `projectUrl` in `agent_spawn`. If they omit placement, the existing repository mapping/fallback behavior is preserved.

Project metadata may later include an optional `chatgptProjectRef` field.

## Launch flow

```text
agent_spawn
 -> resolve local project
 -> apply fixed EXE placement when configured, otherwise accept optional per-worker placement
 -> prepare isolated worker workspace
 -> if still unresolved, resolve current local-project mapping at first launch
 -> persist the resolved Worker placement
 -> open that ChatGPT Project or standalone chat
 -> select the dedicated ChatGPT To Codex Worker app for the task message
 -> send the worker task + scoped worker capability
 -> mark the worker running after launch succeeds
```

The worker app points to `/mcp/worker`. The main `ChatGPT To Codex` app continues to point to `/mcp`. ChatGPT app selection is message-scoped, so the browser launcher explicitly selects the worker app through the `@` picker before it submits the worker task. If the configured worker app is not available, launch fails rather than silently sending the task with the main-agent app.

See `docs/CHATGPT-WORKER-APP-SETUP.md` for the required two-app configuration and live smoke procedure.

## Isolation rule

ChatGPT Project placement must never determine local worker identity, repository scope, or write permissions. Existing local worker IDs, isolated Git worktrees, worker-scoped access checks, and the `/mcp/worker` catalog remain authoritative.

The worker app provides only the worker catalog (`worker_*` plus `worker_finish`). Each repository operation still requires the scoped `workerToken`, so selecting the worker app does not replace the existing worker capability boundary.

Project memory can help related chats, but every worker still receives its task explicitly and must not depend on project memory for correctness.

## M2 integration

### M2.2 Browser worker controller foundation

- Store or resolve an optional repository-to-ChatGPT-Project mapping.
- Define browser-worker state separately from ChatGPT conversation identity.
- Support navigation to a mapped Project with standalone-chat fallback.
- Keep browser failures isolated from Core.

### M2.3 Worker launch/bootstrap

- Open the configured ChatGPT Project when present.
- Otherwise create a standalone worker chat.
- Explicitly select the dedicated worker app before inserting/submitting the task message.
- Fail closed when the worker app is missing rather than using the main app.
- Start the worker only after app selection and bootstrap submission succeed.

### M2.4 Completion/recovery

- Keep the existing local completion/inbox flow as the primary completion path.
- Recovery creates a fresh scoped capability and uses the same worker-app selection path as initial launch.
- Use Project/tab state only for browser recovery and fallback detection.

Automatic creation or renaming of ChatGPT Projects is deferred until simple mapping to an existing Project is proven.

## M7 Worker Placement Policy

M7 is complete. The Windows launcher stores `WorkerProjectUrl` in its settings and exports the normalized value to the runtime as `CHATGPT2CODEX_WORKER_PROJECT_URL`. A non-empty value is authoritative for new Worker placement and overrides per-worker placement requests.

When the setting is empty, placement is dynamic. `agent_spawn` accepts an optional per-worker placement request, while callers that omit it continue using the established project mapping or standalone fallback. Existing Workers keep their resolved route through browser attempts rather than being silently moved by later setting changes.

The implementation deliberately preserves deferred project mapping: a Worker with neither fixed nor explicit per-worker placement is not pinned at spawn, so `agent_project_route_set` may still be called before the first `agent_launch`.

Live Windows validation covered fixed placement, fixed-over-standalone precedence, explicit standalone with an empty setting, and explicit Project placement with an empty setting. Final CI run `35175254790` passed Ubuntu, macOS, and Windows, including the Windows launcher build. See `docs/M7-WORKER-PLACEMENT.md` for the detailed evidence.
