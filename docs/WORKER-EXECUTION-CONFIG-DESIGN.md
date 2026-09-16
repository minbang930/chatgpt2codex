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

Current M6.1 contract:

```ts
type WorkerReasoningEffort = "instant" | "medium" | "high" | "extra-high";
type WorkerExecutionFallbackPolicy = "fail-closed" | "allow-current";

interface WorkerExecutionPreference {
  model?: string;
  reasoningEffort?: WorkerReasoningEffort;
  fallbackPolicy?: WorkerExecutionFallbackPolicy;
}
```

`model` is a trimmed runtime/browser-adapter target string, not an authorization primitive. `Pro`-style model choices belong in `model`, not in `reasoningEffort`.

The normalized reasoning keys track the current product-level reasoning labels. They are durable adapter keys, **not** a promise that every account/profile exposes every choice. M6.3 must inspect the actual dedicated worker profile, map these keys to live UI labels, and verify availability before submission. A future UI label change should remain localized to the browser adapter where possible.

Default behavior:

- if no level specifies a model/reasoning preference, preserve current behavior and do not force a UI change;
- if a model or reasoning preference resolves explicitly and no fallback policy is configured, resolution injects `fallbackPolicy: "fail-closed"` with source `default`;
- an explicit `allow-current` may be configured as a policy default even when model/reasoning are currently unspecified;
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

Resolution is **per field** rather than whole-object replacement. For example, a worker model override can coexist with a project reasoning default and a global fallback policy.

Persist the resolved execution intent with the durable worker record. Recovery reuses that persisted intent instead of re-reading mutable global/project defaults. Durable persistence begins in M6.2; M6.1 only defines and tests the deterministic resolver.

Current normalized intent metadata:

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

M6.1 uses a runtime-owned state file:

```text
<stateDir>/agents/worker-execution-settings.json
```

The file is versioned as `version: 1`, stores one optional global preference plus sorted project entries, and uses the existing temp-file + rename atomic-write pattern with private file/directory permissions where supported. Missing state is treated as an empty/unmanaged configuration for backward compatibility; malformed persisted state fails validation instead of being silently accepted.

The main-agent configuration surface is fixed:

```text
worker_execution_settings_get
worker_execution_settings_set
worker_execution_settings_clear
```

Current semantics:

- scopes are `global` and active `project`;
- `set` replaces the selected scope's normalized preference rather than patch-merging it;
- `clear` removes that scope's preference;
- `get(scope=project)` reports the project preference, inherited global preference, effective per-field resolution, and source metadata;
- reads expose normalized runtime settings only, never browser DOM details;
- all mutations reuse the existing active project's `worker` lease capability, including global mutations, so M6 introduces no new authorization path;
- project reads require an active project but not mutation authority; global reads do not require mutation authority;
- these tools are registered only in the main Web-agent tool surface and are absent from `/mcp/worker`.

The existing `control` and `full-write` presets already intentionally include `worker`, so either can manage these settings without acquiring direct authority outside its existing boundary. Read-only leases cannot mutate them.

## Per-worker override

M6.2 extends the normal worker spawn path with an optional execution override, conceptually:

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

The override must be resolved and persisted before the worker is launched.

## Browser set-and-verify flow

The existing Worker-app routing already follows an important rule: a picker click is not authoritative until the selected Worker-app entity is observed. M6 must apply the same principle to model/reasoning selection.

Preferred launch order:

```text
open mapped ChatGPT Project or standalone ChatGPT
 -> wait for composer/page readiness
 -> read durable worker execution intent
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

### M6.1 - Execution settings foundation — complete

- [x] Inspected current worker record schema, Agent Manager spawn path, MCP registration, project-state patterns, browser session schema, lease boundary, and Chrome/CDP boundary before changing contracts.
- [x] Added normalized worker execution preference/intent types.
- [x] Added versioned global/project settings persistence with atomic writes.
- [x] Added fixed main-agent `get`/`set`/`clear` configuration tools.
- [x] Defined deterministic per-field precedence and source metadata.
- [x] Added focused tests for defaults, global/project storage, per-worker precedence helper behavior, clearing, invalid state/values, authorization, and backward compatibility.
- [x] Kept ChatGPT model/reasoning UI automation untouched.

Implementation sequence:

- `f3a763f0` — execution settings types, versioned persistence, normalization/resolution helpers;
- `418495d1` — settings persistence/resolution tests;
- `19a4ff65` — main-agent settings tools;
- `451dab05` — main-only tool registration;
- `ff568723` — settings-tool authorization/effective-resolution tests;
- `fdc9c6af` — explicit cross-platform CI coverage for the new server tool tests.

Full CI `35125045144` on `fdc9c6af07821870dfd2ca02b83563ea696be590`: **green on macOS, Ubuntu, and Windows**, including typecheck, settings/agent tests, Windows native input/UIA/activity indicator/hostname/startup-context tests, build, and Windows launcher build.

M6.1 exit criterion is satisfied: settings can be configured and resolved deterministically while existing browser launch behavior remains unchanged.

### M6.2 - Durable per-worker intent — active

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

- [x] M6.1 adds no new worker repository authority.
- [x] M6.1 adds no plugin/Skill/Computer Use inheritance into `/mcp/worker`.
- [ ] Global/project setting changes do not mutate running workers. M6.2 will make this durable contract explicit.
- [ ] Explicit settings are verified before bootstrap submission.
- [ ] False-positive UI clicks do not count as success.
- [ ] Recovery reuses persisted intent.
- [ ] Unsupported explicit settings fail closed by default at the browser boundary.
- [x] No private ChatGPT request identity dependency.
- [x] Existing workers/callers without settings remain backward compatible through missing-state/unmanaged behavior.
- [x] M6.1 cross-platform CI is green.

## First action in a new session

M6.1 is complete. The next implementation unit is **M6.2 - Durable per-worker intent**.

Before changing browser automation:

1. read `docs/SESSION-HANDOFF.md`;
2. read this file;
3. verify current `dev/custom-runtime` HEAD and CI;
4. extend the durable worker record/spawn contract for M6.2 only;
5. prove defaults changing after spawn cannot alter an existing worker's stored intent;
6. run focused tests and full CI, then update the three M6 source/handoff documents.

Do not start CDP model-picker automation until M6.2 is complete.