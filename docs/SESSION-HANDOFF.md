# Session Handoff

Operational handoff for continuing `chatgpt2codex` across ChatGPT sessions. Verify this file against the live repository and current CI before making changes; the repository is authoritative when they disagree.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: stable ChatGPT-Web-driven coding runtime without depending on local Codex quota while preserving Core authorization/project/file/shell/git boundaries.

## Current phase

The original M0-M5 roadmap and blocking post-M5 stabilization work are complete. M6 is active.

The only previous stabilization item left open is a **non-blocking natural-use observation**: eventually cross the original 30-minute local-control TTL during ordinary use and confirm there is no `LEASE_REQUIRED` regression. Renewal is already covered by code/CI, so do not delay M6 or force a 30-minute wait just to close this observation.

### Active milestone: M6 - Worker Execution Configuration

Design/source of truth:

- `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`

Purpose: let the runtime explicitly control and verify the ChatGPT Web model and reasoning effort used by browser workers instead of silently inheriting whatever state the dedicated worker Chrome profile currently has.

M6 implementation order:

1. **M6.1 - Execution settings foundation — complete**
2. **M6.2 - Durable per-worker execution intent — active**
3. **M6.3 - ChatGPT Web model/reasoning set-and-verify adapter**
4. **M6.4 - Status/diagnostics**
5. **M6.5 - Live validation**

Do one unit at a time. Do not jump to UI automation before M6.2 establishes the durable per-worker contract.

## How to work with the user

The user prefers implementation-first progress.

- When the user says `진행해`, `이어가자`, `해줘`, or otherwise authorizes the next unit, inspect current repo/CI and do the repo work in the same turn.
- Do not repeatedly ask permission for already-authorized work.
- Work one coherent unit at a time.
- Per unit: **implement -> focused tests/CI -> fix failures -> update progress/handoff/design docs**.
- Prefer concrete state/change/commit/CI reports over speculative explanation.
- Windows/VMware is the active live-validation target while Ubuntu/macOS CI must stay healthy.
- If a live step must be performed by the user, give exact ready-to-run/setup steps and the expected result.

## Persistent engineering boundaries

These are already-proven contracts. Do not weaken or redesign them merely to simplify M6.

- Durable worker state is the source of truth for worker lifecycle/results.
- Full-write workers use isolated Git branches/worktrees and scoped opaque worker capabilities.
- Browser-worker repository authority is derived only from `WORKER_CORE_TOOL_NAMES` plus `worker_finish`.
- `/mcp/worker` exposes the worker-only catalog and has a distinct exact OAuth resource audience from `/mcp`.
- The dedicated `ChatGPT To Codex Worker` custom app must be selected fail-closed; never silently fall back to the main app.
- Worker app selection uses post-click selected-entity verification; a picker click alone is not success.
- Main and worker MCP sessions/tokens cannot be replayed across routes.
- Windows Computer Use reuses the existing control/policy/audit plane.
- Remote `/mcp` must never be able to mint or arm `preset=control`.
- The desktop-control kill switch is independent from lease renewal. Renewal must never clear a kill; a fresh local control grant is still required to resume after a kill.
- Hooks are best-effort observational extensions, not authorization.
- Agent Skills use bounded discovery/install/activation/security paths; skill scripts never execute automatically.
- External MCP plugins remain main-agent extensions; browser workers do not inherit plugin access.
- Pointer/halo/ripple Computer Use experiments were removed. Keep the subtle edge glow unless the user explicitly reopens that work.

## Ponytail

`src/agents/ponytail.ts` is an instruction-layer coding policy, not an authorization mechanism.

- default: `full`
- task-local: `ponytail lite|full|ultra|off` or slash variants
- durable worker task remains unchanged; adaptation is applied only to browser-worker instructions
- never simplify away validation/security/error handling/accessibility/data integrity/user requirements.

## Completed implementation/live-validation baseline

### M0-M5

- M0 baseline/cross-platform CI complete.
- M1 durable multi-agent runtime and isolated worktrees complete.
- M2 ChatGPT Web worker runtime, recovery, worker-scoped Core routing, and worker custom app complete.
- M3 Windows Computer Use complete with live VMware validation.
- M4 Hooks/Ponytail integration complete.
- M5 Agent Skills and external MCP plugin extension model complete.

Detailed history remains in `docs/CUSTOM-RUNTIME-PROGRESS.md`.

### Worker MCP/app isolation

```text
main ChatGPT app   -> /mcp         -> normal main-agent Core catalog
worker ChatGPT app -> /mcp/worker  -> worker_finish + worker_* mirrors only
```

Worker catalog excludes ordinary main file/shell/git tools, plugins, Skills, Agent Manager, and Computer Use. OAuth audiences and MCP sessions are role-bound. The opaque `workerToken` remains the authority for a specific worker/worktree.

### Browser Worker app routing

Current browser worker path:

1. open mapped ChatGPT Project or standalone ChatGPT;
2. wait for composer;
3. handle only the exact stale Worker-app draft case;
4. type/select `@ChatGPT To Codex Worker` from the current app picker;
5. verify the selected inline Worker-app entity;
6. append bootstrap + scoped capability;
7. submit only after verified Worker-app selection.

False-positive clicks fail closed rather than submitting under an unverified app state.

### Live Worker path

Representative live workers proved:

- initial Worker-app selection -> `running` -> `worker_finish` -> `agent_wait` -> `agent_result`;
- parent remained on `control` during worker orchestration without switching to `full-write`;
- true running-worker recovery after manually closing only the worker browser tab;
- same durable workerId recovered in browser attempt 2 and completed normally;
- worker result remained durable and no completion fallback was fabricated.

### Rolling local control authorization

The short control lease UX is hidden behind durable local authorization after the user locally arms control once.

- local control authorization survives ordinary preset changes;
- expired control authorization renews transparently for the capabilities control legitimately owns;
- it never grants `write`, `verify`, `image`, or `remote`;
- remote `/mcp` still cannot grant control;
- renewal never clears the kill switch.

The exact 30-minute wall-clock expiry path is code/CI-proven and remains a natural-use observation only.

### Direct Windows launcher / named tunnel

Direct `start-chatgpt.ps1` launch can reuse the native launcher's saved public hostname when named-tunnel/web exposure is already requested. It also correctly derives startup workspace from `-ActiveProjectRoot` when needed and surfaces early server-start stderr instead of only a generic health timeout. Live VMware validation reached `ChatGPT To Codex is ready` without manually supplying `-PublicHostname`.

## M6 invariant summary

M6 controls model/reasoning execution state without changing worker authorization.

Required precedence:

```text
per-worker override
    > project default
    > global default
    > no explicit preference / current ChatGPT state
```

Resolution is per field. A worker-level model can therefore coexist with a project reasoning default and global fallback policy.

Required durable behavior:

- resolve explicit execution intent when the worker is created;
- persist that resolved intent with the durable worker;
- recovery reuses the same persisted intent even if global/project defaults later change.

Required browser behavior, beginning only in M6.3:

```text
observe current model/reasoning
 -> apply requested change if needed
 -> observe again
 -> verify requested == observed
 -> only then select Worker app and submit bootstrap
```

A model/reasoning picker click is not proof of success. Explicit settings should fail closed by default if they cannot be verified.

## M6.1 completed contract

M6.1 is implemented and full cross-platform CI is green.

### Normalized types

`src/agents/execution-settings.ts` defines:

```text
reasoningEffort = instant | medium | high | extra-high
fallbackPolicy  = fail-closed | allow-current
```

`model` remains a trimmed string target for the future browser adapter. Model choices such as a Pro-style model are represented as `model`, not as `reasoningEffort`.

The reasoning enum represents stable runtime adapter keys, not a guarantee that every target profile exposes all values. M6.3 must inspect/verify actual live availability.

### Persistence

Global/project defaults are stored atomically in:

```text
<stateDir>/agents/worker-execution-settings.json
```

Current file version is `1`. Missing settings state means unmanaged/current ChatGPT behavior and preserves compatibility. Invalid persisted state is rejected rather than silently accepted.

### Resolution

`resolveWorkerExecutionIntent()` resolves each field independently:

```text
worker > project > global
```

If model or reasoning resolves but no fallback policy exists, it adds `fail-closed` from source `default`.

M6.1 does **not** persist this intent on worker records yet; that is the active M6.2 unit.

### Main-agent configuration tools

Main `/mcp` now exposes:

```text
worker_execution_settings_get
worker_execution_settings_set
worker_execution_settings_clear
```

Scopes are `global` and active `project`. `set` replaces a scope; `clear` removes it. Project reads show inherited global and effective merged settings.

All setting mutations, including global ones, require the selected active project's existing `worker` lease capability. This deliberately reuses the established worker-orchestration authorization lane instead of adding global mutable authority. Read-only cannot mutate settings.

These tools are registered through the main Web-agent surface only. `/mcp/worker` does not gain them or any additional authority.

### M6.1 implementation/CI evidence

Implementation sequence:

- `f3a763f0` — normalized types, versioned storage, normalization/resolution helpers;
- `418495d1` — persistence/resolution/compatibility tests;
- `19a4ff65` — fixed get/set/clear tools;
- `451dab05` — main-only registration;
- `ff568723` — tool authorization/effective-resolution tests;
- `fdc9c6af` — CI explicitly runs the new server tool tests on Ubuntu/Windows.

Full CI `35125045144` on code HEAD `fdc9c6af07821870dfd2ca02b83563ea696be590` passed on macOS, Ubuntu, and Windows, including typecheck, settings/agent tests, Windows native input/UIA/activity indicator/hostname/startup-context tests, build, and Windows launcher build.

Existing browser launch behavior is intentionally unchanged by M6.1.

## Active unit

**M6.2 - Durable per-worker intent.**

Implement only this unit next:

- extend `agent_spawn` with an optional `execution` override using the normalized M6.1 contract;
- load global/project defaults and resolve the effective intent during worker creation;
- persist the resolved intent in the durable worker record before browser launch;
- keep legacy worker JSON without execution metadata readable;
- make initial browser launch and recovery read the same stored durable intent rather than re-resolving defaults;
- add lifecycle/recovery regressions proving defaults changed after spawn cannot alter an existing worker's intent.

Do **not** implement ChatGPT model/reasoning DOM selection yet. That starts in M6.3.

Exit criterion: every explicitly configured new worker has a stable durable execution intent before browser launch, and recovery cannot silently change it by re-reading mutable defaults.

## Runtime/update note

`start-chatgpt.ps1` builds only when `dist/cli.js` is missing, not whenever `src` is newer. After pulling M6 TypeScript changes on the VM, run `npm run build` before restarting. M6.1 does not require a live VMware smoke because it intentionally does not change browser launch behavior; live model/reasoning UI work belongs to M6.3/M6.5.

## Source-of-truth documents

- `docs/WORKER-EXECUTION-CONFIG-DESIGN.md` - M6 detailed design and execution order.
- `docs/CUSTOM-RUNTIME-PROGRESS.md` - milestone/stabilization history and verification evidence.
- `docs/CUSTOM-RUNTIME-PLAN.md` - architecture/roadmap.
- `docs/CHATGPT-WORKER-APP-SETUP.md` - two-app configuration.
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md` - Project placement vs message-level Worker-app routing.
- `docs/PLUGINS-DESIGN.md` - external MCP plugin boundary.
- `docs/SKILLS-DESIGN.md` - Agent Skills lifecycle/security.
- `docs/HOOKS-DESIGN.md` - Hooks semantics.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` - Windows Computer Use boundary.

## Handoff maintenance rule

Update this file whenever an M6 unit completes, the active unit changes, an execution-setting contract changes, or live validation changes the next session's operational context. Keep detailed chronological evidence in `CUSTOM-RUNTIME-PROGRESS.md` and detailed M6 design decisions in `WORKER-EXECUTION-CONFIG-DESIGN.md`.

## New-session start procedure

1. Read this file.
2. Read `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.
3. Check actual `dev/custom-runtime` HEAD.
4. Check latest CI for that HEAD.
5. Read the current M6/current-queue portion of `docs/CUSTOM-RUNTIME-PROGRESS.md`.
6. If docs and repo disagree, trust repo and correct the docs.
7. If they match, implement **M6.2 only** and take it through focused tests + full CI before moving to M6.3.

A future user message consisting only of **`SESSION-HANDOFF.md 읽고 M6 이어서 진행해`** should be enough to resume.