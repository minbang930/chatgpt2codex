# Worker Execution Configuration Design (M6)

This document defines the next roadmap milestone after the completed M0-M5 implementation and post-M5 stabilization work.

## Context

Browser workers currently open ChatGPT Web, select the dedicated `ChatGPT To Codex Worker` app, and submit the worker bootstrap. The runtime does **not** currently own or verify the ChatGPT model or reasoning-effort selection before submission.

That means a worker can inherit whatever model/reasoning state the dedicated worker Chrome profile happens to have at launch time. For coding workers this is too implicit: the user may expect a specific model or reasoning level, and recovery should not silently resume the same durable worker under a different execution configuration.

M6 adds explicit, durable, observable worker execution intent while preserving the existing worker capability/worktree/MCP boundaries.

## Goals

M6 must support:

- a runtime-wide worker execution default;
- an optional per-project override;
- an optional per-worker override at spawn time;
- deterministic precedence: **per-worker > project > global > unmanaged/current ChatGPT state**;
- durable resolution of the worker's requested execution intent at worker creation time;
- the same resolved intent on initial launch and browser recovery;
- ChatGPT Web model/reasoning selection **before** worker task submission;
- set-and-verify behavior: a UI interaction is not success until the selected state is observed and matches the requested state;
- fail-closed behavior when an explicit requested setting cannot be verified, unless a deliberately configured fallback policy allows current state;
- status/diagnostic visibility for requested, resolved, observed, and verified execution settings;
- no widening of worker repository/tool capabilities.

## Non-goals

M6 does not:

- replace ChatGPT Web with API-based workers;
- spend local Codex quota;
- infer model/reasoning correctness from prompt text;
- treat a picker click as proof of selection;
- depend on private ChatGPT request/conversation IDs;
- give workers plugin, Computer Use, Skill, Agent Manager, or other main-agent capabilities;
- add another authorization system;
- automatically choose a "best" reasoning level based on task content in the first implementation;
- hard-code model/reasoning DOM knowledge throughout the runtime. UI-specific logic belongs behind the browser adapter.

## Core invariants

The following existing boundaries remain authoritative:

```text
workerId
+ durable worker record
+ isolated Git worktree/branch
+ opaque workerToken
+ /mcp/worker worker-only catalog
```

Execution settings control **which ChatGPT model/reasoning configuration runs the worker**. They do not grant filesystem, repository, plugin, Computer Use, or network authority.

The durable worker record remains the source of truth for a running/recoverable worker. Once a worker is created, later edits to global/project defaults must not silently change that worker's execution intent during recovery.

## Configuration model

Use one normalized runtime structure rather than scattering raw UI strings through the codebase.

Conceptual shape:

```ts
interface WorkerExecutionPreference {
  model?: string;
  reasoningEffort?: WorkerReasoningEffort;
  fallbackPolicy?: "fail-closed" | "allow-current";
}
```

`model` should be treated as a runtime/browser-adapter model key or exact supported display target, not as an authorization primitive.

The exact initial `WorkerReasoningEffort` enum must be based on the reasoning choices actually observable in the target ChatGPT Web UI when M6.1 is implemented. Keep the adapter extensible so a future UI label change does not require changing durable worker semantics everywhere.

Recommended default behavior:

- if no level specifies a model/reasoning preference, preserve current behavior and do not force a UI change;
- if any level resolves an explicit preference, default to `fail-closed` unless the user explicitly configured `allow-current`;
- do not silently downgrade an explicit reasoning request.

## Precedence and resolution

Resolve configuration at worker creation time:

```text
per-worker spawn override
        >
project worker-execution default
        >
global worker-execution default
        >
no explicit preference / current ChatGPT state
```

Persist the resolved execution intent with the durable worker record. Recovery reuses that persisted intent instead of re-reading mutable global/project defaults.

Recommended diagnostic metadata:

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

Do not persist ephemeral DOM identifiers.

## Configuration storage and tools

Prefer a small runtime-owned versioned state file under `stateDir` for global/project worker execution defaults. Reuse existing atomic JSON persistence patterns.

The main-agent configuration surface should remain fixed and explicit. Suggested tool shape:

```text
worker_execution_settings_get
worker_execution_settings_set
worker_execution_settings_clear
```

The exact names may be adjusted to fit the existing MCP naming conventions after inspecting current agent/tool registration.

Requirements:

- global and active-project scopes;
- project mutations must reuse an existing appropriate lease/capability boundary rather than inventing a new one;
- the worker-only `/mcp/worker` catalog must not gain these configuration tools;
- reads should expose normalized settings, not browser DOM details.

A reasonable authorization choice is the existing `worker` capability for project-related worker configuration, because both `control` and `full-write` already intentionally include worker orchestration authority. Confirm this against current lease/tool conventions before implementation.

## Per-worker override

Extend the normal worker spawn path with an optional execution override, for example conceptually:

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

Do not make these fields required. Existing callers with no execution settings must continue to work unchanged.

The override is resolved and persisted before the worker is launched.

## Browser set-and-verify flow

The existing Worker-app routing already follows an important rule: a picker click is not authoritative until the selected Worker-app entity is observed. M6 must apply the same principle to model/reasoning selection.

Preferred launch order:

```text
open mapped ChatGPT Project or standalone ChatGPT
 -> wait for composer/page readiness
 -> resolve durable worker execution intent
 -> inspect current model/reasoning UI state
 -> apply requested model selection if needed
 -> verify observed model state
 -> apply requested reasoning selection if needed
 -> verify observed reasoning state
 -> fail closed if explicit intent cannot be verified
 -> select and verify ChatGPT To Codex Worker app
 -> append bootstrap + scoped capability
 -> submit task
 -> mark browser/worker running
```

If actual ChatGPT UI behavior requires reasoning selection before model selection, or reopening one picker changes the other, keep that sequencing inside the browser execution-settings adapter and cover it with tests. The invariant is verification before bootstrap submission.

No worker bootstrap/task text should be submitted while an explicit execution preference is in an unverified state.

## Browser adapter boundary

Do not mix model/reasoning DOM selectors into worker durable-state or Agent Manager code.

Prefer a narrow adapter in or near the existing Chrome/CDP worker layer, conceptually:

```ts
interface WorkerExecutionUiAdapter {
  observe(...): Promise<ObservedWorkerExecutionSettings>;
  apply(...): Promise<ObservedWorkerExecutionSettings>;
}
```

Keep selector/label matching and ChatGPT UI quirks in this layer. Fake-CDP tests should cover selection success, stale/ambiguous state, false-positive clicks, unsupported values, and verification failure.

## Durable recovery semantics

Recovery must use the same persisted execution intent as initial launch:

```text
worker created with model/reasoning intent
 -> initial browser attempt
 -> target lost while durable worker remains running
 -> old capability revoked
 -> fresh browser attempt
 -> same persisted execution intent reapplied and verified
 -> fresh worker capability issued
 -> same durable worker continues
```

Do not re-resolve from new global/project defaults during recovery.

If the requested model/reasoning is no longer available when recovering, follow the worker's persisted fallback policy. Default explicit-policy behavior should fail closed and surface a recoverable browser-launch error rather than silently changing execution quality.

## Status and diagnostics

Extend worker/browser status output enough to answer:

```text
requested: what did the caller/defaults ask for?
resolved:  what durable intent was stored for this worker?
observed:  what did the ChatGPT UI report on the current browser attempt?
verified:  did observed state satisfy resolved intent before submission?
error:     why could selection/verification not complete?
```

Do not expose private ChatGPT request IDs or brittle raw DOM state.

Suggested browser-attempt diagnostics may include:

```ts
execution: {
  resolvedModel?: string;
  resolvedReasoningEffort?: string;
  observedModel?: string;
  observedReasoningEffort?: string;
  verified?: boolean;
  verificationError?: string;
}
```

Persist only what is useful for recovery/status semantics; avoid turning browser UI telemetry into a new source of truth.

## M6 implementation units

### M6.1 - Execution settings foundation

- Inspect current worker record schema, Agent Manager spawn path, MCP registration, project state patterns, and browser session schema before changing contracts.
- Add normalized worker execution preference/intent types.
- Add versioned global/project settings persistence with atomic writes.
- Add fixed main-agent get/set/clear configuration tools.
- Define exact precedence and resolution helpers.
- Add focused tests for defaults, project override, per-worker precedence, clearing, invalid values, and backward compatibility.
- Do **not** touch ChatGPT UI automation yet.

Exit criterion: settings can be configured/resolved deterministically without changing existing worker launch behavior.

### M6.2 - Durable per-worker intent

- Extend `agent_spawn` with optional execution override.
- Resolve and persist the effective execution intent when the durable worker is created.
- Keep older durable worker records readable through schema migration/defaulting.
- Ensure recovery uses stored intent and does not re-resolve mutable defaults.
- Add lifecycle/recovery tests proving a global/project change after spawn does not alter an existing worker.

Exit criterion: every explicitly configured new worker has a stable durable execution intent before browser launch.

### M6.3 - ChatGPT Web model/reasoning adapter

- Inspect the current live ChatGPT model/reasoning UI in the dedicated worker profile before finalizing selectors/labels.
- Add bounded CDP observation for current model/reasoning state.
- Add model/reasoning selection through a narrow browser adapter.
- Require post-interaction verification before success.
- Integrate it before Worker-app selection/bootstrap submission.
- Initial launch and recovery must share the same path.
- Explicit requested settings default to fail closed on unsupported/unverifiable state.
- Add fake-CDP regressions for false-positive clicks and UI state that never materializes, mirroring the Worker-app selected-entity protections.

Exit criterion: no explicit execution intent can reach bootstrap submission without verified matching UI state.

### M6.4 - Status and diagnostics

- Surface resolved/observed/verified execution information through existing status/result diagnostics where appropriate.
- Distinguish durable intent from current browser-attempt observation.
- Preserve concise normal output when no explicit settings are configured.
- Add tests for successful verification, unsupported selection, recovery failure, and terminal worker status.

Exit criterion: the parent can tell exactly what execution configuration a worker requested and whether the browser verified it.

### M6.5 - Live validation

Use the real dedicated worker Chrome profile and existing worker custom app.

Validate at least:

1. default/no-explicit-setting worker preserves compatibility;
2. one explicit model + reasoning combination is selected and verified before bootstrap;
3. another reasoning level can be selected on a separate worker;
4. two parallel workers may carry different persisted execution intents without sharing state;
5. a running worker browser target can be closed and recovered with the **same** persisted model/reasoning intent;
6. a deliberately unavailable/invalid explicit preference fails before task submission;
7. mapped ChatGPT Project worker routing still works;
8. worker capability/catalog isolation remains unchanged;
9. main `/mcp` app behavior remains unchanged;
10. Ubuntu/macOS/Windows CI remains green.

Record actual live-observed model/reasoning labels and any UI-specific limitations in this document or `docs/CUSTOM-RUNTIME-PROGRESS.md` after validation.

## Parallel-worker implications

M6 is intentionally compatible with future parallel task coordination. Different workers should be able to carry different durable execution intents, for example a deeper reasoning setting for architecture work and a lighter setting for mechanical tests/docs.

M6 itself does not add automatic task classification or coordinator scheduling. Those can be considered later only after explicit per-worker execution control is stable.

## Security and reliability checklist

- [ ] No new worker repository authority.
- [ ] No plugin/Skill/Computer Use inheritance into `/mcp/worker`.
- [ ] Global/project setting changes do not mutate running workers.
- [ ] Explicit settings are verified before bootstrap submission.
- [ ] False-positive UI clicks do not count as success.
- [ ] Recovery reuses persisted intent.
- [ ] Unsupported explicit settings fail closed by default.
- [ ] No private ChatGPT request identity dependency.
- [ ] Existing workers/callers without settings remain backward compatible.
- [ ] Cross-platform CI remains green.

## First action in a new session

Before implementing M6.1:

1. read `docs/SESSION-HANDOFF.md`;
2. read this file;
3. verify the live `dev/custom-runtime` HEAD and CI;
4. inspect the current worker record schema, `agent_spawn` path, browser session record, `src/agents/chrome-cdp.ts`, and relevant MCP tool-registration/lease patterns;
5. implement **M6.1 only**;
6. run focused tests and full CI, fix failures, then update `CUSTOM-RUNTIME-PROGRESS.md`, `SESSION-HANDOFF.md`, and this document before starting M6.2.

Do not jump directly to CDP model-picker automation before the settings/durable-state contracts are established.
