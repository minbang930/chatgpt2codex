# Session Handoff

Operational handoff for continuing `chatgpt2codex` across ChatGPT sessions. Verify this file against the live repository and current CI before making changes; the repository is authoritative when they disagree.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: stable ChatGPT-Web-driven coding runtime without depending on local Codex quota while preserving Core authorization/project/file/shell/git boundaries.

## Current phase

M0-M5 and blocking post-M5 stabilization are complete. **M6 - Worker Execution Configuration** is active.

The only prior stabilization item still open is a non-blocking natural-use observation: eventually cross the original 30-minute local-control TTL and confirm no `LEASE_REQUIRED` regression. Renewal is already code/CI-proven; do not delay M6 or force a wait for it.

### M6 implementation order

1. **M6.1 - Execution settings foundation — complete**
2. **M6.2 - Durable per-worker execution intent — complete**
3. **M6.3 - ChatGPT Web model/reasoning set-and-verify adapter — code/CI complete**
4. **M6.4 - Status/diagnostics — active**
5. **M6.5 - Live validation**

Design/source of truth: `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.

## How to work with the user

The user prefers implementation-first progress. When they say `진행해`, `이어가자`, or otherwise authorize the next unit, inspect the repository/CI and perform the work in the same turn. Work one coherent unit at a time and use the sequence **implement -> focused tests/full CI -> fix failures -> update progress/handoff/design docs**. Windows/VMware is the active live-validation target while Ubuntu/macOS CI must remain healthy.

## Persistent engineering boundaries

Do not weaken these contracts for M6:

- Durable worker state is the source of truth for worker lifecycle/results.
- Full-write workers use isolated Git branches/worktrees and scoped opaque worker capabilities.
- Browser-worker repository authority remains `WORKER_CORE_TOOL_NAMES` plus `worker_finish` only.
- `/mcp/worker` is worker-only and has an exact OAuth resource audience distinct from `/mcp`.
- The dedicated `ChatGPT To Codex Worker` app must be selected fail-closed; never silently fall back to the main app.
- Worker-app picker clicks require post-click selected-entity verification.
- Main/worker MCP sessions and tokens cannot be replayed across routes.
- Remote `/mcp` cannot mint or arm `preset=control`.
- Desktop-control kill switch is independent of lease renewal; renewal never clears a kill.
- Hooks are best-effort observational extensions, not authorization.
- Agent Skill scripts never auto-run.
- External MCP plugins remain main-agent only; browser workers do not inherit them.
- Execution settings change execution quality/state only; they grant no repository, plugin, Skill, Computer Use, or network authority.

## Stable baseline

### M0-M5

- M0 baseline/cross-platform CI complete.
- M1 durable multi-agent runtime and isolated worktrees complete.
- M2 ChatGPT Web worker runtime, recovery, worker-scoped Core routing, and Worker custom app complete.
- M3 Windows Computer Use complete with live VMware validation.
- M4 Hooks/Ponytail complete.
- M5 Agent Skills and external MCP plugins complete.

Detailed history: `docs/CUSTOM-RUNTIME-PROGRESS.md`.

### Worker MCP/app isolation

```text
main ChatGPT app   -> /mcp         -> normal main-agent Core catalog
worker ChatGPT app -> /mcp/worker  -> worker_finish + worker_* mirrors only
```

The opaque `workerToken` remains the authority for a specific worker/worktree. Worker catalog excludes ordinary main file/shell/git tools, plugins, Skills, Agent Manager, and Computer Use.

### Browser worker routing/recovery

The established Worker-app routing remains fail closed: the dedicated app must materialize as the selected entity before bootstrap text is submitted. True target-loss recovery has also been live-proven: durable `running` worker remained authoritative, lost target reconciled to browser `failed`, same workerId relaunched in attempt 2, and normal `worker_finish` completion remained durable.

M6.3 inserts execution verification before this existing Worker-app flow when a worker has explicit model/reasoning intent.

### Rolling local control authorization

A locally armed control grant persists separately from the normal active lease and transparently renews only `read`, `control`, and `worker`. It survives ordinary preset changes but never grants `write`, `verify`, `image`, or `remote`; remote `/mcp` still cannot create initial control authority. Live `control -> full-write -> Computer Use` coexistence was proven.

### Direct Windows launcher

`start-chatgpt.ps1` can reuse the saved public hostname for an already-requested named tunnel/web exposure, derives workspace from `-ActiveProjectRoot` when appropriate, and reports early server stderr. Live VMware reached `ChatGPT To Codex is ready` without manually supplying `-PublicHostname`.

## M6 invariant summary

Precedence is field-by-field:

```text
per-worker override > project default > global default > unmanaged/current ChatGPT state
```

If an explicit model/reasoning value resolves without a configured fallback, fallback defaults to `fail-closed`.

Stable runtime keys currently are:

```text
reasoningEffort = instant | medium | high | extra-high
fallbackPolicy  = fail-closed | allow-current
```

`model` remains a normalized string target. The browser adapter owns matching it to the current ChatGPT execution picker and must verify the resulting state before submission.

## M6.1 completed contract

`src/agents/execution-settings.ts` provides normalized preferences/intents, deterministic precedence, and versioned atomic global/project persistence at:

```text
<stateDir>/agents/worker-execution-settings.json
```

Main `/mcp` exposes `worker_execution_settings_get`, `worker_execution_settings_set`, and `worker_execution_settings_clear`. Mutations reuse the existing `worker` capability. `/mcp/worker` does not expose these tools. Missing settings preserve legacy unmanaged/current-ChatGPT behavior.

Implementation sequence: `f3a763f0`, `418495d1`, `19a4ff65`, `451dab05`, `ff568723`, `fdc9c6af`.
Full CI `35125045144` on `fdc9c6af07821870dfd2ca02b83563ea696be590` passed macOS/Ubuntu/Windows.

## M6.2 completed contract

`agent_spawn` accepts optional execution overrides. `spawnAgent()` resolves worker/project/global settings exactly once and stores optional `WorkerRecord.executionIntent` before browser launch. Legacy/no-settings workers omit that field. Later changes to mutable defaults do not alter an existing worker, and both initial launch and same-worker recovery load the same durable intent.

Implementation/test sequence: `b234c58f`, `ff13722c`, `9e5de414`, `da5a10ca`, `c3017969`, `ecb1f076`.
Full CI `35129481274` on `ecb1f0764f6fd4080012e202304ea09c4d2a2a7a`: **green on macOS, Ubuntu, and Windows**.

## M6.3 completed code contract

M6.3 adds a narrow set-and-verify browser adapter at `src/agents/chrome-execution.ts` and wires the durable intent into both initial browser launch and recovery.

### Launch ordering

For workers with explicit model/reasoning intent, current launch order is:

```text
open ChatGPT / wait for composer
 -> read durable executionIntent from BrowserWorkerLaunchInput
 -> open bounded execution picker
 -> apply model/reasoning interaction if needed
 -> re-observe structural state and verify
 -> only then select/verify ChatGPT To Codex Worker
 -> insert bootstrap + worker capability
 -> submit
```

No explicit execution intent means the adapter returns immediately without touching execution controls, preserving legacy behavior.

### Current structural adapter

The adapter is intentionally bounded near the CDP layer. Based on current public ChatGPT Web implementation evidence available during M6.3, it supports:

- the existing model-switcher test-id when present;
- the newer neutral composer-pill/unified intelligence-picker structure when that test-id is absent;
- exact normalized model-row matching with unique-match requirements;
- structural reasoning observation through `[data-model-reasoning-effort-slider] [role="slider"]` and its ARIA min/max/current value;
- runtime effort mapping to the first four structural positions: `instant`, `medium`, `high`, `extra-high`;
- native CDP pointer events followed by fresh observation rather than accepting a synthetic/picker click as success.

This is **not yet a live VMware/profile compatibility claim** for every visible model label. The exact model names/account availability in the user's dedicated Worker Chrome profile still belong to M6.5 live validation. If the live UI differs, extend only the browser adapter without weakening fail-closed verification.

### Fallback policy

- `fail-closed`: unsupported, ambiguous, missing, or non-materializing requested execution state aborts before Worker-app selection/bootstrap.
- `allow-current`: the adapter may continue unverified only because that permission was already persisted in the durable worker intent.

### M6.3 tests/CI

Regression coverage includes:

- model + reasoning successful set-and-verify;
- unavailable/ambiguous model targets;
- false-positive model interaction that never materializes selected state;
- reasoning pointer interaction that does not update structural ARIA state;
- unsupported `extra-high` when the profile exposes too few slider positions;
- deliberate `allow-current` behavior;
- unmanaged/no-explicit-setting compatibility;
- durable intent reaching both initial launch and recovery;
- execution verification happening before the first Worker-app/bootstrap `Input.insertText`;
- fail-closed execution failure producing no Worker-app mention, bootstrap insertion, or Enter submission.

Implementation/test sequence: `d5741d07`, `2d15d532`, `7e0cedfd`, `c562e130`, `8960867e`, `43c6afae`, `dd423f59`, final type-narrowing fix `dcc73aba`.
Full CI `35131605738` on code HEAD `dcc73abac90cc925137df42a7a03139bcd85ec80`: **green on macOS, Ubuntu, and Windows**, including Agent tests, Windows native input/UIA/activity-indicator/hostname/startup-context checks, build, and Windows launcher build.

## Active unit

**M6.4 - Status and diagnostics.**

Implement only this unit next:

- expose the durable requested/resolved/source execution intent through existing worker status diagnostics;
- keep browser-attempt observed/verified state separate from durable intent;
- record concise execution verification failure information on the browser attempt without turning browser telemetry into durable worker truth;
- preserve concise output for workers with no explicit execution settings;
- add success/failure/recovery/terminal-state regressions;
- do not begin live model/reasoning compatibility claims until M6.5.

M6.4 should not widen worker authority, expose private ChatGPT request IDs, or redesign the execution-selection adapter.

## Runtime/update note

`start-chatgpt.ps1` builds only when `dist/cli.js` is missing. After pulling M6 TypeScript changes on the VM, run `npm run build` before restarting. A real dedicated-profile model/reasoning smoke is intentionally deferred to M6.5, after M6.4 gives us stable diagnostics to inspect.

## Source-of-truth documents

- `docs/WORKER-EXECUTION-CONFIG-DESIGN.md` — M6 design and implementation order.
- `docs/CUSTOM-RUNTIME-PROGRESS.md` — milestone/history and CI evidence.
- `docs/CUSTOM-RUNTIME-PLAN.md` — architecture/roadmap.
- `docs/CHATGPT-WORKER-APP-SETUP.md` — two-app configuration.
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md` — Project placement vs message-level Worker-app routing.
- `docs/PLUGINS-DESIGN.md` — plugin boundary.
- `docs/SKILLS-DESIGN.md` — Agent Skills lifecycle/security.
- `docs/HOOKS-DESIGN.md` — Hooks semantics.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` — Windows Computer Use boundary.

## Handoff maintenance rule

Update this file whenever an M6 unit completes, the active unit changes, an execution-setting contract changes, or live validation changes the next session's operational context. Keep detailed chronological evidence in `CUSTOM-RUNTIME-PROGRESS.md` and detailed M6 design decisions in `WORKER-EXECUTION-CONFIG-DESIGN.md`.

## New-session start procedure

1. Read this file.
2. Read `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.
3. Check actual `dev/custom-runtime` HEAD and latest CI.
4. Read the current M6/current-queue portion of `docs/CUSTOM-RUNTIME-PROGRESS.md`.
5. If docs and repo disagree, trust repo and correct the docs.
6. If they match, implement **M6.4 only** and take it through tests/full CI before M6.5.

A future message consisting only of **`SESSION-HANDOFF.md 읽고 M6 이어서 진행해`** should be enough to resume.
