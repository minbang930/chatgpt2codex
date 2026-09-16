# Worker Execution Configuration Design (M6)

This document defines the worker execution configuration milestone after M0-M5 and post-M5 stabilization.

## Context

Browser workers open ChatGPT Web, select the dedicated `ChatGPT To Codex Worker` app, and submit the worker bootstrap. Before M6, the runtime did not own or verify the ChatGPT model or reasoning-effort selection, so a worker could silently inherit whatever state the dedicated worker Chrome profile happened to have.

M6 adds explicit, durable, observable worker execution intent while preserving existing worker capability/worktree/MCP boundaries.

## Goals

M6 must support:

- a runtime-wide worker execution default;
- an optional per-project override;
- an optional per-worker override at spawn time;
- deterministic precedence: **per-worker > project > global > unmanaged/current ChatGPT state**;
- durable resolution at worker creation time;
- the same resolved intent on initial launch and browser recovery;
- ChatGPT Web model/reasoning selection before worker task submission;
- set-and-verify behavior rather than trusting picker clicks;
- fail-closed behavior for unverifiable explicit requests unless `allow-current` is deliberately configured;
- requested/resolved/observed/verified diagnostics;
- no widening of worker repository/tool authority.

## Non-goals

M6 does not:

- replace ChatGPT Web with API-based workers;
- spend local Codex quota;
- infer model/reasoning correctness from prompt text;
- treat a picker click as proof of selection;
- depend on private ChatGPT request/conversation IDs;
- give workers plugin, Computer Use, Skill, Agent Manager, or other main-agent capabilities;
- add another authorization system;
- automatically choose a best reasoning level based on task content in the first implementation;
- scatter model/reasoning DOM selectors throughout durable-state/Agent Manager code.

## Core invariants

Existing boundaries remain authoritative:

```text
workerId
+ durable worker record
+ isolated Git worktree/branch
+ opaque workerToken
+ /mcp/worker worker-only catalog
```

Execution settings control **which ChatGPT model/reasoning configuration runs the worker**. They do not grant filesystem, repository, plugin, Computer Use, Skill, or network authority.

The durable worker record remains the source of truth for a running/recoverable worker. Once a worker is created, later global/project default edits must not change that worker's execution intent.

Browser execution telemetry is attempt-scoped evidence only. It may describe what the current/last browser attempt observed, but it never replaces durable worker lifecycle/result state or durable execution intent.

## Configuration model

Implemented normalized preference:

```ts
interface WorkerExecutionPreference {
  model?: string;
  reasoningEffort?: "instant" | "medium" | "high" | "extra-high";
  fallbackPolicy?: "fail-closed" | "allow-current";
}
```

The reasoning values are stable runtime adapter keys, not raw DOM labels and not a guarantee that every ChatGPT profile exposes every option. `model` is a normalized runtime/browser-adapter target string, not an authorization primitive.

Default behavior:

- no model/reasoning preference anywhere -> preserve existing unmanaged/current ChatGPT behavior;
- any explicit model/reasoning preference without a fallback -> `fail-closed`;
- never silently downgrade an explicit reasoning request under `fail-closed`.

## Precedence and resolution

Resolution is per field:

```text
per-worker spawn override
        >
project worker-execution default
        >
global worker-execution default
        >
no explicit preference / current ChatGPT state
```

Implemented intent shape:

```ts
interface WorkerExecutionIntent {
  requested?: WorkerExecutionPreference;
  resolved?: WorkerExecutionPreference;
  sources?: {
    model?: "worker" | "project" | "global";
    reasoningEffort?: "worker" | "project" | "global";
    fallbackPolicy?: "worker" | "project" | "global" | "default";
  };
}
```

No ephemeral DOM identifiers are persisted.

## Configuration storage and tools

M6.1 implemented versioned atomic storage at:

```text
<stateDir>/agents/worker-execution-settings.json
```

The file contains one global preference and optional project preferences. Missing state preserves legacy behavior; invalid persisted state is rejected.

Main-agent tools are fixed:

```text
worker_execution_settings_get
worker_execution_settings_set
worker_execution_settings_clear
```

Implemented behavior:

- scopes are `global` and active `project`;
- mutations reuse the existing active project's `worker` capability;
- `/mcp/worker` does not expose these configuration tools;
- reads expose normalized settings/effective resolution, not browser DOM details;
- changing defaults never mutates existing durable workers.

## Per-worker override and durable creation

M6.2 extends normal spawn with optional:

```text
agent_spawn(
  task=...,
  execution={
    model: ...,
    reasoningEffort: ...,
    fallbackPolicy: ...
  }
)
```

Existing callers remain valid without `execution`.

`spawnAgent()` now performs this order:

```text
load global/project defaults
 -> merge optional per-worker override
 -> resolve WorkerExecutionIntent
 -> create durable WorkerRecord with optional executionIntent
 -> provision worktree
 -> later browser launch
```

`WorkerRecord.executionIntent` is optional. No-settings/legacy workers omit it, preserving backward compatibility. Once written, this durable intent is not recomputed for that worker. Initial launch and recovery load the same WorkerRecord.

## Browser set-and-verify flow

M6.3 applies the same principle already used for Worker-app selection: a UI click is not authoritative until the expected state is observed afterward.

Implemented launch order for explicit execution intent:

```text
open mapped ChatGPT Project or standalone ChatGPT
 -> wait for composer/page readiness
 -> read durable worker execution intent
 -> discover bounded execution picker
 -> apply requested model selection if needed
 -> observe and verify model
 -> apply requested reasoning selection if needed
 -> observe and verify reasoning
 -> enforce fallback policy
 -> select and verify ChatGPT To Codex Worker app
 -> append bootstrap + scoped capability
 -> submit task
 -> mark browser/worker running
```

No explicit model/reasoning preference returns immediately without touching execution controls, preserving the pre-M6 browser behavior.

The invariant is that no explicit `fail-closed` intent reaches Worker-app/bootstrap submission without verified matching state.

## Browser adapter boundary

Model/reasoning UI knowledge is isolated in `src/agents/chrome-execution.ts`; durable worker state and Agent Manager remain DOM-agnostic.

M6.3 uses current structural signals observed in public/current ChatGPT Web implementations rather than relying on old screenshots or product-memory selectors:

- old/current model-switcher test-id when available;
- newer neutral `__composer-pill` / unified intelligence-picker structural controls;
- menu/radio selected-state attributes for model observation;
- `[data-model-reasoning-effort-slider] [role="slider"]` with ARIA min/max/current values for reasoning effort.

Model matching is normalized but requires one unambiguous target row. Reasoning maps stable runtime effort keys to the first four structural slider positions. Account/profile availability is checked structurally; an unavailable requested position fails closed by default.

Interactions use native CDP pointer events. After any interaction, the adapter re-observes state and verifies it. A successful pointer/click dispatch is not itself success.

The exact visible model names and effort availability in the user's dedicated Worker Chrome profile are intentionally left for M6.5 live validation. If the live profile uses a different nested picker or label structure, extend this adapter only; do not weaken verification or leak DOM assumptions into durable state.

## Fallback policy

- `fail-closed`: missing, unsupported, ambiguous, or non-materializing requested execution state aborts before Worker-app selection/bootstrap.
- `allow-current`: the browser may continue unverified only when this policy was already persisted in the durable worker intent.

`allow-current` is a deliberate compatibility escape hatch, not an implicit fallback.

## Durable recovery semantics

Implemented:

```text
worker created with persisted executionIntent
 -> initial browser attempt receives same executionIntent
 -> apply/verify it before bootstrap
 -> persist attempt-scoped execution observation
 -> target lost while durable worker remains running
 -> old capability revoked
 -> fresh browser attempt receives same durable executionIntent
 -> apply/verify it again before bootstrap
 -> replace current attempt-scoped execution observation
 -> same durable worker continues
```

Recovery never re-resolves from new global/project defaults. If a previously requested setting is no longer available, the persisted fallback policy governs behavior; default explicit behavior is fail closed.

## Status and diagnostics

M6.4 implements a strict separation between durable intent and browser-attempt observation.

Durable worker state keeps:

```text
requested: caller/default request resolved at spawn
resolved:  durable model/reasoning/fallback intent
sources:   worker/project/global/default source metadata
```

`BrowserWorkerSession` optionally keeps the latest attempt's bounded telemetry:

```ts
interface BrowserWorkerExecutionDiagnostic {
  verified: boolean;
  observedModel?: string;
  observedReasoningEffort?: "instant" | "medium" | "high" | "extra-high";
  error?: string;
}
```

The browser diagnostic contains normalized execution evidence only. It never contains private ChatGPT request/conversation IDs or raw DOM state.

Successful explicit launches persist their observed/verified state. `allow-current` may persist an unverified observation and bounded error. Fail-closed verification errors attach the same structured diagnostic to the `DomainError`, so the failed browser attempt can record what was observed without fabricating a durable worker failure/completion.

`agent_status` and `agent_result` surface a top-level execution view when relevant:

```text
execution.requested
execution.resolved
execution.sources
execution.observed
execution.verified
execution.error
execution.attempt
```

`agent_status` performs the existing browser liveness reconciliation before building the view. `agent_result` combines durable result state with already-persisted browser telemetry and deliberately does not probe/reconcile the browser during a result read.

When neither durable execution intent nor browser execution telemetry exists, no empty execution object is emitted; unmanaged workers retain the concise legacy shape.

## M6 implementation units

### M6.1 - Execution settings foundation — complete

Implemented normalized types, versioned global/project persistence, fixed main-agent get/set/clear tools, precedence/resolution helpers, compatibility/authorization tests, and no browser UI automation.

Implementation sequence: `f3a763f0`, `418495d1`, `19a4ff65`, `451dab05`, `ff568723`, `fdc9c6af`.
CI `35125045144` on `fdc9c6af07821870dfd2ca02b83563ea696be590`: green on macOS/Ubuntu/Windows.

### M6.2 - Durable per-worker intent — complete

Implemented optional `agent_spawn.execution`, pre-creation worker/project/global resolution, optional validated `WorkerRecord.executionIntent`, backward-compatible old/no-settings workers, immutable intent across default changes, and launch/recovery reuse of the same durable record.

Implementation/test sequence: `b234c58f`, `ff13722c`, `9e5de414`, `da5a10ca`, `c3017969`, `ecb1f076`.
CI `35129481274` on `ecb1f0764f6fd4080012e202304ea09c4d2a2a7a`: green on macOS/Ubuntu/Windows.

### M6.3 - ChatGPT Web model/reasoning adapter — code/CI complete

Implemented:

- `chrome-execution.ts` bounded adapter;
- current structural execution-control/picker discovery;
- unique normalized model matching and selected-state verification;
- structural ARIA reasoning-slider observation and targeting;
- native CDP pointer interactions followed by fresh verification;
- persisted `fail-closed` / `allow-current` behavior;
- no-op compatibility path for unmanaged workers;
- `BrowserWorkerLaunchInput.executionIntent` propagated directly from durable `WorkerRecord.executionIntent`;
- same launch path used by initial launch and recovery;
- execution verification before Worker-app selection/bootstrap text insertion;
- fake-CDP regressions for unsupported/ambiguous values, false-positive interactions, unavailable effort, allow-current, ordering, and pre-bootstrap failure.

Implementation/test sequence: `d5741d07`, `2d15d532`, `7e0cedfd`, `c562e130`, `8960867e`, `43c6afae`, `dd423f59`, `dcc73aba`.
CI `35131605738` on `dcc73abac90cc925137df42a7a03139bcd85ec80`: **green on macOS, Ubuntu, and Windows**.

Exit criterion satisfied at the code/CI level: explicit fail-closed execution intent cannot reach Worker-app/bootstrap submission unless the requested state has been structurally verified. Dedicated-profile model-label compatibility remains an M6.5 live-validation concern, not a reason to weaken the adapter.

### M6.4 - Status and diagnostics — complete

Implemented:

- optional validated `BrowserWorkerSession.execution` attempt telemetry;
- successful verified and deliberate `allow-current` observations persisted separately from durable intent;
- structured fail-closed diagnostic propagation through `DomainError.details.workerExecution`;
- browser launch failure persistence without mutating durable worker lifecycle truth;
- `agent_status` execution view combining durable requested/resolved/sources with current-attempt observed/verified/error/attempt;
- `agent_result` execution view using the durable result plus already-persisted browser telemetry without browser reconciliation;
- latest-attempt telemetry replacing older attempt observation on recovery while durable intent remains unchanged;
- no execution key for unmanaged workers with no intent/observation;
- success, fail-closed failure, recovery/latest-attempt, unmanaged compatibility, and terminal-state regressions.

Implementation/test sequence: `92827274`, `1a7199ac`, `477bc99c`, `e693b36d`, `a1117d2f`.
CI `35132971767` on `a1117d2fd08d57f49aa62d55de7a0b7cd8dd499f`: **green on macOS, Ubuntu, and Windows**.

Exit criterion satisfied: the parent can distinguish the durable execution request/resolution from the current browser attempt's observed/verified state and bounded verification error.

### M6.5 - Live validation — active

Use the real dedicated worker Chrome profile and existing Worker custom app. Validate at least:

1. default/no-explicit-setting compatibility;
2. one explicit model + reasoning combination selected/verified before bootstrap;
3. another reasoning level on a separate worker;
4. two parallel workers carrying different durable intents;
5. target-loss recovery with the same persisted intent and fresh attempt telemetry;
6. deliberately unavailable/invalid explicit preference fails before task submission and reports bounded diagnostics;
7. mapped ChatGPT Project routing still works;
8. worker capability/catalog isolation unchanged;
9. main `/mcp` behavior unchanged;
10. Ubuntu/macOS/Windows CI remains green after any live-driven adapter fix.

Record the exact live-observed model/reasoning labels, slider range, and any account/profile limitations after validation. If live UI differs from the structural assumptions above, adapt only `chrome-execution.ts` and keep post-interaction verification fail closed.

## Parallel-worker implications

Different workers may carry different durable execution intents. M6 does not add automatic task classification or coordinator scheduling; those should only be considered after explicit per-worker execution control is stable.

## Security and reliability checklist

- [x] No new worker repository authority.
- [x] No plugin/Skill/Computer Use inheritance into `/mcp/worker`.
- [x] Global/project setting changes do not mutate existing/running workers' durable intent.
- [x] Explicit fail-closed settings are verified before bootstrap submission in the browser adapter.
- [x] False-positive model/reasoning interactions do not count as success.
- [x] Recovery reuses persisted intent instead of re-resolving defaults.
- [x] Unsupported explicit settings fail closed by default in the browser adapter.
- [x] Durable intent is separated from browser-attempt telemetry in status/result diagnostics.
- [x] Browser verification failures do not fabricate durable worker failure/completion.
- [x] Unmanaged workers preserve concise legacy status/result output.
- [x] No private ChatGPT request identity dependency.
- [x] Existing workers/callers without settings remain backward compatible.
- [x] M6.4 cross-platform CI is green.
- [ ] Dedicated-profile live model/reasoning compatibility is validated. (M6.5)

## First action in a new session

M6.1-M6.4 are code/CI complete. Next:

1. read `docs/SESSION-HANDOFF.md` and this file;
2. verify `dev/custom-runtime` HEAD and latest CI;
3. pull/build/restart the Windows VMware runtime through its known-good path;
4. run **M6.5 live validation** using the real dedicated Worker Chrome profile;
5. use `agent_status` / `agent_result` execution diagnostics to record requested/resolved/observed/verified/error/attempt evidence;
6. if the live UI differs, update only the browser execution adapter and focused tests, then rerun full CI.

Do not claim dedicated-profile model labels or slider availability until M6.5 observes them live.
