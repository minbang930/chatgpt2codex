# Custom Runtime Plan

This document is the design/roadmap for the `dev/custom-runtime` fork work.

## Goal

Extend `chatgpt2codex` into a stable ChatGPT-Web-driven coding runtime that can keep working when local Codex quota is exhausted.

The fork must preserve the original project's reliable Core path and add only the pieces we actually need.

## Core constraints

- Do **not** depend on local Codex for worker execution.
- ChatGPT Web is the reasoning/agent surface; local runtime provides trusted project tools.
- Keep the stable Core connector/tool surface small and predictable.
- Avoid provider-internal conversation/request identity coupling (`wfr_`, hidden turn ownership, etc.).
- Prefer explicit local IDs, durable local state, Git isolation, and handshakes we control.
- Add one coherent capability at a time, with tests before moving to the next slice.
- New worker/browser/plugin failures must not break the normal single-agent file/shell/git path.

## Target architecture

```text
ChatGPT Web (main)
    |
    | stable Core MCP tools
    v
chatgpt2codex Custom Runtime
    |
    +-- Existing Core
    |   +-- project selection / lease
    |   +-- code search / read / patch / create
    |   +-- shell / command execution
    |   +-- git status / diff / commit / push
    |
    +-- Agent Manager
    |   +-- worker lifecycle
    |   +-- durable worker inbox
    |   +-- completion/event notifications
    |   +-- short event wait
    |   +-- result retrieval
    |   +-- cancellation
    |
    +-- Worker Workspace Manager
    |   +-- one Git branch per worker
    |   +-- one isolated Git worktree per worker
    |   +-- project-confined write access
    |
    +-- Browser Worker Controller
    |   +-- open ChatGPT worker tab
    |   +-- send bootstrap + task
    |   +-- associate tab with opaque worker identity
    |   +-- fallback DOM completion detection only
    |
    +-- Windows Computer Use
    |
    +-- Hook Engine
    |
    +-- Optional Plugins connector
        +-- external MCP servers
```

## Worker lifecycle

Canonical worker states:

```text
pending -> running -> completed
                   -> failed
                   -> cancelled
```

A worker is identified by a local opaque `workerId`. The runtime must not need ChatGPT's private request IDs to determine ownership.

Each worker eventually owns:

- `workerId`
- project ID
- task
- isolated worktree path
- worker branch
- browser tab/session handle (when Web workers are added)
- state/result/error
- optional commit SHA / changed files / checks
- durable completion notification

## Completion and result delivery

Use two complementary mechanisms:

1. **Durable inbox = source of truth**
   - worker final state/result is persisted locally.
   - survives process restart.
   - result remains available after notification delivery.

2. **Piggyback notification = attention mechanism**
   - when a normal Core MCP tool returns, attach a short notice for newly completed workers.
   - mark only that notification as delivered; never discard the worker result.
   - do not attach full worker output to every normal tool result.

Planned agent tools:

```text
agent_spawn
agent_status
agent_result
agent_wait
agent_cancel
worker_finish
```

`agent_spawn` should return quickly. The main ChatGPT continues working asynchronously.

`agent_wait` is an event wait, not the primary result-return path. Full results come from `agent_result`.

## Git isolation

Full-write workers must never share the main working tree with each other.

Each worker receives its own branch and worktree. Worktrees should live under runtime-managed state rather than inside the user's main checkout so that creating a worker does not introduce `.workers/` noise into the project status.

Conceptually:

```text
main repo:      C:\Dev\Project
worker branch:  agent/wrk_<id>
worker tree:    <stateDir>/agents/worktrees/<project>/<worker>
```

Worker tools resolve the opaque worker identity to the assigned worktree. A worker must not be able to choose an arbitrary filesystem root.

## Browser worker model

Browser automation is deliberately deferred until the local agent runtime and worktree lifecycle are proven.

Primary completion path:

```text
worker does work
 -> verifies changes
 -> commits if appropriate
 -> calls worker_finish
 -> local inbox is updated
```

DOM inspection is fallback-only for cases where the model/browser terminates without calling `worker_finish`.

## Hooks

Later, add a small lifecycle hook engine inspired by Codex-style hooks. Initial candidates:

- `SessionStart`
- `PreToolUse`
- `PostToolUse`
- `SubagentStart`
- `SubagentStop`

Hooks may run local commands or local/MCP handlers, but Core operation must remain usable when hooks are absent or fail safely.

This can later support Ponytail-style behavior without hard-coding those rules into Core.

## Plugins

Keep plugins separate from Core.

```text
ChatGPT2Codex Core
  -> stable, fixed tool surface

ChatGPT2Codex Plugins
  -> optional external MCP tools
  -> schema may change as plugins are installed/removed
```

This separation reduces the chance that plugin discovery/schema changes destabilize the Core coding tools.

## Milestones

### M0 - Baseline

- Fork created.
- Development branch created.
- Cross-platform typecheck/build CI.
- Full test suite on macOS, where the existing desktop-control tests are intended to run.

### M1 - Local multi-agent runtime

- Durable worker state.
- Durable completion inbox.
- Worker-specific Git branch/worktree isolation.
- Agent Manager service/API.
- MCP agent tools.
- Completion notification piggyback.
- Short event wait.

No browser worker yet.

### M2 - ChatGPT Web workers

- Browser worker controller.
- Worker bootstrap/task delivery.
- Opaque worker identity handoff.
- `worker_finish` primary completion path.
- DOM fallback completion detection.
- Parallel worker lifecycle/cancellation tests.

### M3 - Windows Computer Use

- Native Windows desktop control suited to the VMware worker environment.
- Keep it independent from Browser Worker completion/identity logic.

### M4 - Hooks

- Local lifecycle hook engine.
- Start with session/tool/subagent events only.
- Add Ponytail-compatible behavior only after the core hook semantics are stable.

### M5 - Plugins

- Separate optional Plugins connector.
- External MCP discovery/configuration.
- Plugin failure isolation from Core.

## Explicit non-goals for early milestones

- Reimplementing Codex itself.
- Spending local Codex quota to run subagents.
- Depending on OpenAI API Agents as the worker runtime.
- Reverse-engineering private ChatGPT request identity for correctness.
- Automatically merging every worker branch into main.
- Building browser automation before local worker state/worktree behavior is tested.
- Building a plugin marketplace before Core multi-agent behavior is stable.

## Development rule

Finish and verify one unit before starting the next. If a later feature needs to change an earlier contract, update this plan and the progress log explicitly rather than silently widening the scope.
