# ChatGPT Project Worker Routing

This document extends the custom runtime plan for Web worker organization.

## Goal

When a local repository is linked to a ChatGPT Project, new worker chats should be created inside that ChatGPT Project. This is only for UI organization.

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
 -> create a new worker chat
 -> send the worker task
 -> mark the worker running after launch succeeds
```

## Isolation rule

ChatGPT Project placement must never determine local worker identity, repository scope, or write permissions. Existing local worker IDs, isolated Git worktrees, and worker-scoped access checks remain authoritative.

Project memory can help related chats, but every worker still receives its task explicitly and must not depend on project memory for correctness.

## M2 integration

### M2.2 Browser worker controller foundation

- Store or resolve an optional repository-to-ChatGPT-Project mapping.
- Define browser-worker state separately from ChatGPT conversation identity.
- Support navigation to a mapped Project with standalone-chat fallback.
- Keep browser failures isolated from Core.

### M2.3 Worker launch/bootstrap

- Open the configured ChatGPT Project when present.
- Create a dedicated worker chat inside it.
- Otherwise create a standalone worker chat.
- Start the worker only after launch succeeds.

### M2.4 Completion/recovery

- Keep the existing local completion/inbox flow as the primary completion path.
- Use Project/tab state only for browser recovery and fallback detection.

Automatic creation or renaming of ChatGPT Projects is deferred until simple mapping to an existing Project is proven.
