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

## Configuration model

Implemented normalized preference:

```ts
interface WorkerExecutionPreference {
  model?: string;
  reasoningEffort?: "instant" | "medium" | "high" | "extra-high";
  fallbackPolicy?: "fail-closed" | "allow-current";
}
```

The reasoning values are stable runtime adapter keys, not raw DOM labels and not a guarantee that every ChatGPT profile exposes every option. M6.3 must inspect the current live worker-profile UI and map only actually observable options to these stable keys. UI label changes should remain isolated to the browser adapter.

`model` is a normalized runtime/browser-adapter target string, not an authorization primitive.

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

Requirements/implemented behavior:

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

`WorkerRecord.executionIntent` is optional. No-settings/legacy workers omit it, preserving backward compatibility.

Once written, this durable intent is not recomputed for that worker. Initial launch and recovery load the same WorkerRecord. Later changes to global/project defaults therefore affect future workers only.

## Browser set-and-verify flow

M6.3 must apply the same principle already used for Worker-app selection: a UI click is not authoritative until the expected state is observed afterward.

Target launch order:

```text
open mapped ChatGPT Project or standalone ChatGPT
 -> wait for composer/page readiness
 -> read durable worker execution intent
 -> inspect current model/reasoning UI state
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

If the actual current UI requires another sequencing order, keep that sequencing inside the browser execution adapter. The invariant is that no explicit `fail-closed` intent reaches Worker-app/bootstrap submission without verified matching state.

## Browser adapter boundary

Do not mix model/reasoning DOM selectors into worker durable-state or Agent Manager code.

Preferred boundary:

```ts
interface WorkerExecutionUiAdapter {
  observe(...): Promise<ObservedWorkerExecutionSettings>;
  apply(...): Promise<ObservedWorkerExecutionSettings>;
}
```

Selector/label matching and ChatGPT UI quirks belong in or near the Chrome/CDP layer. Fake-CDP tests must cover successful selection, unsupported values, stale/ambiguous state, false-positive clicks, and verification failure.

Before implementing selector/label mapping, inspect the **current live ChatGPT Web model/reasoning controls in the dedicated worker Chrome profile**. Do not freeze selectors from memory or an older UI.

## Durable recovery semantics

Implemented durable foundation from M6.2:

```text
worker created with persisted executionIntent
 -> initial browser attempt reads durable worker
 -> target lost while durable worker remains running
 -> old capability revoked
 -> fresh browser attempt reads same durable worker
 -> same executionIntent remains available unchanged
```

M6.3 adds reapplication and verification on both attempts:

```text
fresh browser attempt
 -> apply/verify same persisted intent
 -> fresh worker capability
 -> same durable worker continues
```

Recovery must never re-resolve from new global/project defaults. If a previously requested setting is no longer available, the persisted fallback policy governs behavior; default explicit behavior is fail closed.

## Status and diagnostics

M6.4 will surface enough information to answer:

```text
requested: caller/default intent
resolved:  durable intent stored with worker
observed:  UI state for current browser attempt
verified:  whether observed state satisfied durable intent
error:     why selection/verification failed
```

Do not expose private ChatGPT request IDs or brittle raw DOM state. Browser-attempt diagnostics may include normalized resolved/observed model/reasoning, `verified`, and a bounded verification error. Durable intent remains the recovery source of truth; browser telemetry does not replace it.

## M6 implementation units

### M6.1 - Execution settings foundation — complete

Implemented:

- normalized preference/intent types;
- versioned global/project persistence;
- fixed main-agent get/set/clear tools;
- per-field precedence/resolution helpers;
- compatibility/validation/authorization tests;
- no ChatGPT UI automation.

Implementation sequence: `f3a763f0`, `418495d1`, `19a4ff65`, `451dab05`, `ff568723`, `fdc9c6af`.
CI `35125045144` on `fdc9c6af07821870dfd2ca02b83563ea696be590`: green on macOS/Ubuntu/Windows.

Exit criterion satisfied.

### M6.2 - Durable per-worker intent — complete

Implemented:

- optional `agent_spawn.execution` override;
- global/project/worker resolution before durable worker creation;
- optional validated `WorkerRecord.executionIntent` persistence;
- backward-compatible older/no-settings worker records;
- immutable intent across later default changes;
- initial launch/recovery both reuse the same stored worker record rather than re-resolving settings;
- lifecycle/recovery and MCP regressions.

Implementation/test sequence: `b234c58f`, `ff13722c`, `9e5de414`, `da5a10ca`, `c3017969`, `ecb1f076`.
CI `35129481274` on `ecb1f0764f6fd4080012e202304ea09c4d2a2a7a`: green on macOS/Ubuntu/Windows.

The lifecycle regression explicitly changes global/project defaults after spawn, launches the worker, marks the browser target failed, recovers the same durable worker, and verifies the original stored intent never changes.

Exit criterion satisfied.

### M6.3 - ChatGPT Web model/reasoning adapter — active

- Inspect the current live ChatGPT model/reasoning UI in the dedicated worker profile before finalizing selectors/labels.
- Add bounded CDP observation for current normalized model/reasoning state.
- Add model/reasoning selection through a narrow browser adapter.
- Require post-interaction verification before success.
- Consume persisted `WorkerRecord.executionIntent` before Worker-app selection/bootstrap submission.
- Initial launch and recovery must share the same execution adapter path.
- Explicit requested settings default to fail closed on unsupported/unverifiable state.
- Implement deliberate `allow-current` behavior without misreporting verification.
- Add fake-CDP regressions for false-positive clicks and UI state that never materializes.

Exit criterion: no explicit execution intent can reach bootstrap submission without satisfying its configured verification/fallback policy.

### M6.4 - Status and diagnostics

- Surface durable resolved intent and current-attempt observed/verified execution information through existing status/result diagnostics where appropriate.
- Distinguish durable intent from browser-attempt observation.
- Preserve concise output when no explicit settings are configured.
- Add success/failure/recovery/terminal-state tests.

Exit criterion: the parent can tell what execution configuration a worker requested and whether the browser verified it.

### M6.5 - Live validation

Use the real dedicated worker Chrome profile and existing Worker custom app. Validate at least:

1. default/no-explicit-setting compatibility;
2. one explicit model + reasoning combination selected/verified before bootstrap;
3. another reasoning level on a separate worker;
4. two parallel workers carrying different durable intents;
5. target-loss recovery with the same persisted intent;
6. deliberately unavailable/invalid explicit preference fails before task submission;
7. mapped ChatGPT Project routing still works;
8. worker capability/catalog isolation unchanged;
9. main `/mcp` behavior unchanged;
10. Ubuntu/macOS/Windows CI green.

Record actual live-observed UI labels and limitations after validation.

## Parallel-worker implications

Different workers may carry different durable execution intents. M6 does not add automatic task classification or coordinator scheduling; those should only be considered after explicit per-worker execution control is stable.

## Security and reliability checklist

- [x] No new worker repository authority.
- [x] No plugin/Skill/Computer Use inheritance into `/mcp/worker`.
- [x] Global/project setting changes do not mutate existing/running workers' durable intent.
- [ ] Explicit settings are verified before bootstrap submission. (M6.3)
- [ ] False-positive model/reasoning UI clicks do not count as success. (M6.3)
- [x] Recovery reuses persisted intent instead of re-resolving defaults.
- [ ] Unsupported explicit settings fail closed by default in the live browser adapter. (M6.3)
- [x] No private ChatGPT request identity dependency.
- [x] Existing workers/callers without settings remain backward compatible.
- [x] M6.2 cross-platform CI remains green.

## First action in a new session

Before implementing M6.3:

1. read `docs/SESSION-HANDOFF.md` and this file;
2. verify `dev/custom-runtime` HEAD and current CI;
3. inspect current `WorkerRecord.executionIntent`, browser launch/recovery path, and `src/agents/chrome-cdp.ts`;
4. inspect the **real current dedicated-worker ChatGPT model/reasoning UI** before choosing selectors or display-label mappings;
5. implement **M6.3 only**;
6. run focused fake-CDP regressions and full cross-platform CI, fix failures, then update progress/handoff/design docs before M6.4.

Do not infer current model/reasoning UI structure from old screenshots, product memory, or prompt text.
