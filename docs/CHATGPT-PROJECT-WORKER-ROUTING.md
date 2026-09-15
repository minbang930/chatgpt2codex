# ChatGPT Project Worker Routing

This document extends the custom runtime plan for Web worker organization and message-level app routing.

## Goal

When a local repository is linked to a ChatGPT Project, new worker chats should be created inside that ChatGPT Project. Project placement is only for UI organization. Repository authority comes from the dedicated worker MCP app plus the existing worker capability/worktree model.

## Mapping

```text
local repository -> optional ChatGPT Project reference
```

Recommended default: one repository per ChatGPT Project.

Project metadata may later include an optional `chatgptProjectRef` field.

## Launch flow

```text
agent_spawn
 -> resolve local project
 -> resolve optional ChatGPT Project reference
 -> prepare isolated worker workspace
 -> open the mapped ChatGPT Project, or use a standalone chat when no mapping exists
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
