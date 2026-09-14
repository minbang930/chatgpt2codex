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
- A worker must never reuse or mutate the main ChatGPT session's global active-project/lease state.

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
    +-- Worker Capability / Scoped Dispatcher
    |   +-- opaque local worker capability
    |   +-- worker-specific in-memory ToolContext
    |   +-- fixed active project + full-write lease rooted at worker worktree
    |   +-- explicit allowlist of reused Core coding tools
    |   +-- no mutation of global sessions.json
    |
    +-- Browser Worker Controller
    |   +-- open ChatGPT worker tab
    |   +-- send bootstrap + task
    |   +-- hand off worker capability
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
- a scoped local worker capability (raw token is not stored persistently)
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

Agent tools:

```text
agent_spawn
agent_status
agent_result
agent_wait
agent_cancel
worker_finish
```

`agent_spawn` returns quickly. The main ChatGPT continues working asynchronously.

`agent_wait` is an event wait, not the primary result-return path. Full results come from `agent_result`.

## Git isolation

Full-write workers must never share the main working tree with each other.

Each worker receives its own branch and worktree. Worktrees live under runtime-managed state rather than inside the user's main checkout so that creating a worker does not introduce `.workers/` noise into the project status.

Conceptually:

```text
main repo:      C:\Dev\Project
worker branch:  agent/wrk_<id>
worker tree:    <stateDir>/agents/worktrees/<project>/<worker>
```

Worker tools resolve the opaque worker capability to the assigned worktree. A worker must not be able to choose an arbitrary filesystem root.

## Worker-scoped tool routing

The upstream runtime persists one global `sessions.json` containing a single active project/mode/lease. That is correct for the normal single-agent Core path but is unsafe for parallel Web workers: if every worker used normal `project_select`, workers and the main chat would race on the same session.

Therefore Web workers do **not** use the global Core session directly.

For each worker invocation the runtime derives an isolated in-memory `ToolContext`:

```text
worker capability
 -> verify capability -> workerId
 -> verify managed worktree
 -> derive one-project registry rooted at worker worktree
 -> derive in-memory active session + full-write lease
 -> invoke only an explicit allowlist of existing Core handlers
```

The scoped context must never persist its active project/lease into the main `sessions.json`. Reuse existing Core handlers/policies rather than duplicating file/shell/git safety logic.

Worker capabilities are local opaque bearer tokens. Persist only a cryptographic hash plus lifecycle metadata. Reissuing a capability replaces the prior one. Browser/session identity is not part of authorization correctness.

Remote push, workspace scanning/switching, desktop control, image intake, and other unrelated Core surfaces are not exposed to worker routing by default.

## Browser worker model

Browser automation starts only after worker-scoped tool routing is proven.

Primary completion path:

```text
worker does work
 -> verifies changes
 -> commits if appropriate
 -> calls worker_finish with its worker capability
 -> local inbox is updated
```

DOM inspection is fallback-only for cases where the model/browser terminates without calling `worker_finish`.

The browser controller may know a tab handle for launch/cancel/recovery, but correctness must not depend on discovering ChatGPT's private conversation or request identity.

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

#### M2.1 - Worker-scoped Core routing

- Opaque worker capability issue/verify/revoke lifecycle.
- In-memory worker-specific ToolContext rooted at the managed worktree.
- Explicit allowlist of reused Core coding handlers.
- No global `sessions.json` mutation from worker calls.
- Worker-side completion authorization with the capability.
- Cross-platform isolation tests.

#### M2.2 - Browser worker controller foundation

- Local browser-worker session record separate from ChatGPT conversation identity.
- Launch/cancel/controller interfaces.
- Browser failures isolated from Core and M1 agent tools.

#### M2.3 - ChatGPT worker launch/bootstrap

- Open a dedicated ChatGPT worker tab.
- Send worker bootstrap/task.
- Hand off the opaque worker capability.
- Transition `pending -> running` only after worker launch/acceptance succeeds.

#### M2.4 - Completion/recovery

- `worker_finish` remains the primary completion path.
- DOM fallback completion detection.
- Browser close/failure/cancellation recovery.
- Parallel worker lifecycle tests.

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
- Letting workers call normal `project_select` against the global Core session.
- Letting workers push remotes by default.
- Building browser automation before local worker state/worktree/scoped-routing behavior is tested.
- Building a plugin marketplace before Core multi-agent behavior is stable.

## Development rule

Finish and verify one unit before starting the next. If a later feature needs to change an earlier contract, update this plan and the progress log explicitly rather than silently widening the scope.
