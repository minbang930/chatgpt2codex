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
3. **M6.3 - ChatGPT Web model/reasoning set-and-verify adapter — active**
4. **M6.4 - Status/diagnostics**
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

Current proven path:

1. open mapped ChatGPT Project or standalone ChatGPT;
2. wait for composer;
3. clear only the exact stale Worker-app draft case;
4. type/select `@ChatGPT To Codex Worker`;
5. verify the selected inline Worker-app entity;
6. append bootstrap + scoped capability;
7. submit only after verified Worker-app selection.

True target-loss recovery has been live-proven: durable `running` worker remained authoritative, lost target reconciled to browser `failed`, same workerId relaunched in attempt 2, and normal `worker_finish` completion remained durable.

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

`model` is a normalized string target; the browser adapter owns translation to the current ChatGPT UI.

## M6.1 completed contract

`src/agents/execution-settings.ts` provides normalized preferences/intents, deterministic precedence, and versioned atomic global/project persistence at:

```text
<stateDir>/agents/worker-execution-settings.json
```

Main `/mcp` exposes:

```text
worker_execution_settings_get
worker_execution_settings_set
worker_execution_settings_clear
```

Mutations reuse the existing `worker` capability. `/mcp/worker` does not expose these tools. Missing settings preserve legacy unmanaged/current-ChatGPT behavior.

Implementation sequence: `f3a763f0`, `418495d1`, `19a4ff65`, `451dab05`, `ff568723`, `fdc9c6af`.
Full CI `35125045144` on `fdc9c6af07821870dfd2ca02b83563ea696be590` passed macOS/Ubuntu/Windows.

## M6.2 completed contract

M6.2 resolves execution intent exactly once at worker creation and stores it with the durable worker.

### Spawn surface

`agent_spawn` now accepts optional:

```ts
execution?: {
  model?: string;
  reasoningEffort?: "instant" | "medium" | "high" | "extra-high";
  fallbackPolicy?: "fail-closed" | "allow-current";
}
```

Existing callers need not supply it.

### Durable record

`WorkerRecord` now has optional:

```ts
executionIntent?: WorkerExecutionIntent
```

The field is optional for backward compatibility. Workers created when no global/project/per-worker execution preference exists omit it entirely and continue legacy behavior.

`spawnAgent()` loads the current global/project defaults, combines the optional worker override through `resolveWorkerExecutionIntent()`, and passes the resolved intent into `createWorker()` **before** browser launch/worktree execution begins.

### Immutability/recovery semantics

Once the worker is created, mutable defaults are no longer consulted for that worker. State transitions preserve `executionIntent` through record spreading. Initial browser launch and `recoverRunningBrowserWorker()` both load the same durable worker record, so a later global/project settings change cannot silently alter a running/recoverable worker's stored intent.

M6.2 deliberately does not yet apply this intent to ChatGPT Web. The current browser driver still behaves exactly as before; M6.3 is responsible for consuming and verifying the durable intent before bootstrap submission.

### M6.2 tests/CI

Regression coverage proves:

- worker/project/global per-field resolution is persisted before launch;
- changing global/project defaults after spawn does not mutate the worker;
- the same intent survives initial launch, target loss, and same-worker recovery;
- legacy/no-settings workers remain readable without execution metadata;
- MCP `agent_spawn.execution` wins over lower-precedence defaults.

Implementation/test sequence: `b234c58f`, `ff13722c`, `9e5de414`, `da5a10ca`, `c3017969`, `ecb1f076`.
Full CI `35129481274` on code HEAD `ecb1f0764f6fd4080012e202304ea09c4d2a2a7a`: **green on macOS, Ubuntu, and Windows**.

## Active unit

**M6.3 - ChatGPT Web model/reasoning set-and-verify adapter.**

Before finalizing selectors or label mapping, inspect the **current live ChatGPT model/reasoning UI in the dedicated worker Chrome profile**. Do not guess from old layouts or hard-code model strings based only on product knowledge.

M6.3 scope:

- add a narrow browser execution-settings adapter near the CDP layer;
- observe current model/reasoning state with bounded DOM queries;
- map stable runtime keys to the live UI discovered during implementation;
- consume the durable `WorkerRecord.executionIntent` on initial launch and recovery;
- apply requested changes only when needed;
- re-observe after interaction and verify requested == observed;
- explicit `fail-closed` intent must prevent Worker-app selection/bootstrap if verification fails;
- `allow-current` behavior must be deliberate and tested;
- false-positive clicks, ambiguous/stale state, unsupported values, and verification failure need fake-CDP regressions;
- initial launch and recovery must share the same adapter path.

Do not expand worker authority or expose private ChatGPT request/conversation IDs. M6.4, not M6.3, owns the final parent-facing status/diagnostic presentation beyond what is necessary for adapter errors/tests.

Exit criterion: no explicit execution intent can reach bootstrap submission without satisfying its configured verification/fallback policy.

## Runtime/update note

`start-chatgpt.ps1` builds only when `dist/cli.js` is missing. After pulling M6 TypeScript changes on the VM, run `npm run build` before restarting. M6.2 itself does not require a separate live smoke because it does not alter browser UI behavior; M6.3 requires live UI inspection before selectors/labels are finalized.

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
6. If they match, implement **M6.3 only**, beginning with live dedicated-worker UI inspection before selector/label implementation.

A future message consisting only of **`SESSION-HANDOFF.md 읽고 M6 이어서 진행해`** should be enough to resume.
