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
- New worker/browser/skill/plugin failures must not break the normal single-agent file/shell/git path.
- A worker must never reuse or mutate the main ChatGPT session's global active-project/lease state.
- Windows is the only active target for new Computer Use work. Existing macOS/Linux code may remain, but new M3 design/verification must not expand just to preserve cross-platform parity.

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
    |   +-- dedicated Chrome worker profile
    |   +-- Chrome DevTools Protocol (CDP) local tab control
    |   +-- mapped ChatGPT Project preferred, standalone chat fallback
    |   +-- send bootstrap + task + worker capability
    |   +-- local CDP target id only for cancel/recovery
    |   +-- fallback DOM completion detection only
    |
    +-- Windows Computer Use
    |   +-- existing control lease/queue/policy/audit
    |   +-- persistent native Windows helper
    |   +-- screenshot + UIA observation
    |   +-- semantic/coordinate action backend
    |   +-- visible Computer Use activity border
    |
    +-- Hook Engine
    |
    +-- Agent Skills
    |   +-- SKILL.md registry + progressive disclosure
    |   +-- project/global scope
    |   +-- Git/local install provenance
    |   +-- browser-worker instruction integration
    |
    +-- Optional Plugins connector
        +-- external MCP servers
        +-- optional plugin-provided skills
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
- browser tab/session handle (local CDP target id, not ChatGPT conversation identity)
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

The primary browser path is a dedicated Google Chrome profile under runtime-managed state, controlled locally through Chrome DevTools Protocol (CDP). Chrome is started with a non-default `--user-data-dir` and a loopback remote-debugging endpoint. The user signs into ChatGPT in this dedicated profile once; later workers reuse that authenticated profile.

This was chosen over a custom browser extension/local launch bridge because CDP provides the smaller ownership surface: no extension lifecycle, no bridge HTTP endpoint, and no ChatGPT private request/conversation attribution. If CDP proves insufficient in real-world testing, an extension can be reconsidered as a fallback rather than maintained in parallel from the start.

Worker launch flow:

```text
prepared durable worker
 -> issue scoped worker capability
 -> ensure dedicated Chrome profile / CDP endpoint
 -> open mapped ChatGPT Project URL, or chatgpt.com when unmapped
 -> wait for the normal ChatGPT composer
 -> inject + submit worker bootstrap/task/capability
 -> only then mark durable worker running
```

If a mapped ChatGPT Project does not present a usable composer, the launch may fall back to a standalone ChatGPT chat. If the dedicated profile is not signed in, leave the browser available for login and keep the durable worker retryable instead of damaging its worktree.

Primary completion path:

```text
worker does work
 -> verifies changes
 -> commits if appropriate
 -> calls worker_finish with its worker capability
 -> local inbox is updated
```

DOM inspection is fallback-only for cases where the model/browser terminates without calling `worker_finish`.

The browser controller may know a local CDP target id for launch/cancel/recovery, but correctness must not depend on discovering ChatGPT's private conversation or request identity.

## Windows Computer Use

M3 is Windows-only. Reuse the existing control plane (`lease -> policy -> approval queue -> kill switch -> audit`) and add only Windows observation/action/indicator backends.

Detailed design and external-repository research are recorded in `docs/WINDOWS-COMPUTER-USE-DESIGN.md`.

Primary direction:

```text
existing control plane
    |
    v
persistent Windows helper
    +-- Win32 window resolve/activation
    +-- SendInput
    +-- UI Automation observation/actions
    +-- app-window screenshot capture
    +-- click-through activity-border overlay
```

Borrow architecture and edge-case handling from mature implementations rather than reproducing their whole runtimes:

- Microsoft UFO: Win32 + UIA inspection, bulk/cached semantic properties, layered screenshot fallback.
- UI-TARS Desktop: small Operator boundary, compact action vocabulary, explicit DPI/coordinate normalization.
- Microsoft PowerToys: native non-activating/topmost overlay patterns for the visible Computer Use indicator.

Do not add Python/pywinauto, NutJS, or another desktop framework unless live Windows testing identifies a concrete reliability gap that justifies the added dependency.

The visible activity border is UX only; it must never become part of authorization correctness. It should be topmost, no-activate, click-through, absent from screenshots supplied to the model, and cleared on idle/kill/cancel.

## Hooks

The M4 lifecycle engine supports:

- `SessionStart`
- `PreToolUse`
- `PostToolUse`
- `SubagentStart`
- `SubagentStop`

Hooks are best-effort local extension points. Core operation remains usable when hooks are absent or fail. Ponytail-style coding guidance is kept at the worker instruction layer rather than turning generic hooks into a policy engine.

## Agent Skills and plugins

M5 is an **Extensions** phase rather than only an external-MCP phase.

Portable Agent Skills use the conventional `SKILL.md` package model. Installed skills are discovered through lightweight metadata and loaded progressively only when relevant. Initial scopes are:

```text
Project: <project>/.agents/skills/
Global:  <stateDir>/skills/
```

Project skills override same-named global skills. Skill discovery/loading must remain bounded and must not execute bundled scripts merely because a directory was discovered.

External Git/local installs must record source/ref/resolved-commit provenance and copy/export reviewed content into a managed skill directory rather than using a mutable checkout as live instruction state.

External MCP plugins remain separate from Core:

```text
ChatGPT2Codex Core
  -> stable, fixed tool surface

Agent Skills
  -> optional portable instructions/resources
  -> progressive disclosure

ChatGPT2Codex Plugins
  -> optional external MCP tools
  -> schema may change as plugins are installed/removed
```

This separation reduces the chance that skill/plugin discovery or schema changes destabilize Core coding tools. See `docs/SKILLS-DESIGN.md` for the detailed M5 contract.

## Milestones

### M0 - Baseline

- Fork created.
- Development branch created.
- Cross-platform typecheck/build CI.
- Full test suite on macOS, where the existing desktop-control tests were originally intended to run.

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
- Local project -> optional ChatGPT Project routing.
- Launch/cancel/controller interfaces.
- Browser failures isolated from Core and M1 agent tools.

#### M2.3 - ChatGPT worker launch/bootstrap

- Dedicated Chrome profile with local CDP endpoint.
- Open a dedicated ChatGPT worker tab.
- Prefer the mapped ChatGPT Project; standalone fallback when unavailable.
- Send worker bootstrap/task.
- Hand off the opaque worker capability without persisting the raw token locally.
- Transition `pending -> running` only after worker bootstrap submission succeeds.
- Revoke the launch capability and leave the worker retryable when browser bootstrap fails.
- Wire the launch path into `agent_spawn` without blocking the main chat.

#### M2.4 - Completion/recovery

- `worker_finish` remains the primary completion path.
- DOM fallback completion detection.
- Browser close/failure/cancellation recovery.
- Parallel worker lifecycle tests.

### M3 - Windows Computer Use

#### M3.1 - Windows backend foundation

- Stabilize persistent helper IPC/lifecycle.
- Exact window resolve/activation.
- Mouse, Unicode typing, hotkeys/keys.
- Small platform backend/operator boundary.
- Unit/CI checks without injecting input into a headless runner.

#### M3.2 - Windows observation

- App/window enumeration.
- Allowlisted app-window screenshot pipeline.
- Screenshot validation and privacy gates.
- DPI/coordinate normalization.

#### M3.3 - UIA semantic layer

- Bounded/cached UIA snapshot.
- Ephemeral semantic target ids scoped to an observation.
- Semantic invoke/value/focus/selection where supported.
- Coordinate fallback retained.

#### M3.4 - Computer Use activity indicator

- Thin click-through topmost border/label while Computer Use is active.
- No focus stealing or taskbar/Alt-Tab presence.
- Exclude or hide the overlay from screenshots.
- Kill/cancel/idle always clears it.

#### M3.5 - VMware live smoke validation

- Validate screenshot -> target -> action loops on the actual interactive Windows VM.
- Exercise Notepad/basic text app, Explorer, browser, multi-window focus, DPI scaling, kill/cancel, repeated sessions, and activity-border behavior.

### M4 - Hooks

- Local lifecycle hook engine.
- Session/tool/subagent lifecycle events.
- Ponytail-compatible worker guidance after generic hook semantics are stable.

### M5 - Extensions

#### M5.1 - Agent Skills foundation

- `SKILL.md` metadata parser.
- Safe bounded local loader.
- Global/project skill roots and project-over-global precedence.
- Collision diagnostics and on-demand full skill loading.
- No network install or executable skill content yet.

#### M5.2 - Skill management

- `skill_list` / `skill_view` progressive-disclosure MCP surface.
- Git/local install, remove, and update.
- project/global target scope.
- source/ref/resolved-commit provenance.

#### M5.3 - Skill activation

- Bounded skill metadata catalog for the main ChatGPT agent.
- Explicit full-skill activation/view.
- Selected-skill integration into browser-worker bootstrap/recovery.
- Keep durable worker task unchanged.

#### M5.4 - Skill resources and security

- Bounded `references/`, `templates/`, and `assets/` access.
- External-source static scan/trust reporting.
- Executable `scripts/` disabled by default; any future execution requires a separate reviewed/approved contract.

#### M5.5 - External MCP plugins

- Separate optional Plugins connector.
- External MCP discovery/configuration.
- Plugin failure isolation from Core.
- Optional plugin-provided skills through explicit configuration/manifest boundaries.
- No automatic worker access to plugin tools.

### M6 - Worker Execution Configuration

M6 makes browser-worker model/reasoning selection explicit, durable, and verifiable. Detailed design: `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.

#### M6.1 - Execution settings foundation

- Normalized worker execution preference/intent types.
- Versioned global/project defaults.
- Fixed main-agent get/set/clear configuration surface.
- Deterministic precedence: per-worker > project > global > unmanaged/current ChatGPT state.
- Focused validation/backward-compatibility tests.
- No ChatGPT model/reasoning UI automation yet.

#### M6.2 - Durable per-worker intent

- Optional execution override on worker spawn.
- Resolve and persist effective execution intent when the durable worker is created.
- Existing worker records remain backward compatible.
- Recovery reuses stored intent instead of re-reading mutable defaults.

#### M6.3 - ChatGPT Web model/reasoning set-and-verify

- Observe current model/reasoning state through a narrow CDP/browser adapter.
- Apply requested settings before Worker-app/bootstrap submission.
- Re-observe and verify selected state after every relevant UI interaction.
- Explicit requests fail closed by default when unsupported or unverifiable.
- Initial launch and browser recovery share the same path.

#### M6.4 - Status and diagnostics

- Surface requested/resolved/observed/verified execution state through existing worker/browser diagnostics.
- Keep durable intent separate from ephemeral browser-attempt observation.
- Preserve concise output when no explicit settings are configured.

#### M6.5 - Live validation

- Default/no-explicit-setting compatibility.
- Explicit model/reasoning selection and verification.
- Multiple reasoning levels.
- Parallel workers with distinct durable execution intents.
- Same-worker browser recovery preserves execution intent.
- Invalid/unavailable explicit preference fails before task submission.
- Mapped ChatGPT Project routing and worker capability/catalog isolation remain intact.
- Ubuntu/macOS/Windows CI remains green.

## M8 - Multi-backend Project Execution

M8 expands the runtime from a single local execution path into a persistent ChatGPT Project that can route work between GitHub and machine-specific local workspaces while preserving existing Core/Worker/Computer Use boundaries.

Detailed architecture: `docs/MULTI-BACKEND-EXECUTION-ARCHITECTURE.md`.

The six concepts are deliberately separate:

```text
Project
Backend
Machine
Workspace
Agent
State
```

Key requirements:

- GitHub remains a first-class backend that works while local PCs are unavailable.
- Local execution remains the path for real filesystem access, local tests, Computer Use, and workers.
- One ChatGPT Project may bind different local roots on MAIN-PC, VMware, and future machines.
- The same ChatGPT chat should automatically receive the current machine/backend context instead of requiring the user to restate it.
- Backend and Agent are independent so local ChatGPT, Codex, Claude Code, and Worker can coexist.
- Switching targets must surface dirty/unpushed state rather than pretending unpublished changes are visible elsewhere.
- Preserve existing `Project.root`, lease, Worker capability/worktree, `/mcp/worker`, and Computer Use authorization semantics during migration.
- Start with the execution data model/resolver and machine bindings. Investigate normal-Chat Project identity before considering any ChatGPT Windows app patch.
- A Windows-app patch, if required, is limited to Project identity/routing/UI context; it must not duplicate the existing execution engine.

Planned units:

```text
M8.0 documentation/invariants
M8.1 execution model + versioned execution.json
M8.2 machine identity + local Project bindings
M8.3 execution state observation
M8.4 Chat execution-context injection
M8.5 GitHub backend integration
M8.6 Codex / Claude Code / Worker agent integration
M8.7 ChatGPT Windows Project-identity/UX integration
M8.8 explicit handoff workflow
```

M8.0 is documentation-only. No M8 runtime implementation should begin before the new execution model is reviewed against the current `dev/custom-runtime` repository.

## Explicit non-goals for early milestones

- Reimplementing Codex itself.
- Spending local Codex quota to run subagents.
- Depending on OpenAI API Agents as the worker runtime.
- Reverse-engineering private ChatGPT request identity for correctness.
- Automatically merging every worker branch into main.
- Letting workers call normal `project_select` against the global Core session.
- Letting workers push remotes by default.
- Maintaining both a CDP driver and an extension/bridge path before real-world evidence justifies the extra browser integration.
- Building a skill/plugin marketplace before local install/activation behavior is stable.
- Automatically executing third-party skill scripts or package-manager install instructions during discovery.
- Expanding M3 to macOS/Linux parity when Windows is the only required Computer Use target.
- Automatically assigning model/reasoning effort from task content before explicit M6 execution control is stable.

## Development rule

Finish and verify one unit before starting the next. If a later feature needs to change an earlier contract, update this plan and the progress log explicitly rather than silently widening the scope.
