# Session Handoff

Operational handoff for continuing `chatgpt2codex` across ChatGPT sessions. Verify this file against the live repository and current CI before making changes; the repository is authoritative when they disagree.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: stable ChatGPT-Web-driven coding runtime without depending on local Codex quota while preserving Core authorization/project/file/shell/git boundaries.

## Current phase

M0-M5, blocking post-M5 stabilization, **M6 - Worker Execution Configuration**, and **M7 - Worker Placement Policy are complete**. **M8 - Multi-backend Project Execution is the next roadmap phase; M8.0 documentation/invariants are complete and runtime implementation has not started.**

Final M6 cross-platform CI: GitHub Actions run `35172617811` on post-validation HEAD `5dac24f96bd9ae162ad26a0b29bfeb96883526bd` passed Ubuntu, macOS, and Windows.

Final M7 cross-platform CI: GitHub Actions run `35175254790` on `1eaf8fa75c24bf814b37090e5f0b4a02bfabb7bd` passed Ubuntu, macOS, and Windows, including the Windows launcher build.

The only prior stabilization item still open is a non-blocking natural-use observation: eventually cross the original 30-minute local-control TTL and confirm no `LEASE_REQUIRED` regression. Renewal is already code/CI-proven and this does not block milestone progress.

### M6 implementation order

1. **M6.1 - Execution settings foundation — complete**
2. **M6.2 - Durable per-worker execution intent — complete**
3. **M6.3 - ChatGPT Web model/reasoning set-and-verify adapter — complete**
4. **M6.4 - Status/diagnostics — complete**
5. **M6.5 - Live validation — complete**
6. **Final post-validation CI confirmation — complete** (`35172617811`)

Design/source of truth: `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.
Detailed live evidence: `docs/M6-LIVE-VALIDATION.md`.

## M7 completed contract

M7 adds a Worker placement policy without changing repository authority or Worker MCP isolation. The Windows launcher exposes a `Worker ChatGPT Project URL` setting. When non-empty, it is passed to the runtime as `CHATGPT2CODEX_WORKER_PROJECT_URL` and forces new workers into that ChatGPT Project. When blank, placement stays dynamic.

Placement precedence for a new Worker is:

```text
existing durable Worker placement (recovery)
  > EXE fixed Worker Project URL
  > explicit per-worker placement from agent_spawn
  > existing local-project -> ChatGPT-Project mapping
  > standalone ChatGPT
```

Compatibility detail: when neither a fixed EXE URL nor an explicit per-worker placement exists, project mapping is intentionally resolved at first launch rather than at spawn. This preserves the established `agent_spawn -> agent_project_route_set -> agent_launch` workflow. Once the first route is resolved, it is persisted for that Worker.

Live Windows evidence:

- fixed URL with no Project mention created the Worker in the configured Project;
- worker `wrk_0dc5fe1c-d919-46a2-9f3e-4cbbce5995b8` requested `standalone` while the EXE fixed URL was set, but launched in the fixed Project and completed with `changedFiles=[]`;
- worker `wrk_f3f6ddb0-a6f5-4706-9090-6aa04b8e0900` launched standalone when the EXE field was blank and completed with `changedFiles=[]`;
- worker `wrk_caa6c047-cd2f-4ff7-bf6c-f750fdcd5f2e` requested a specific Project while the EXE field was blank, and the actual `browser.projectUrl` matched exactly before task submission.

Detailed evidence: `docs/M7-WORKER-PLACEMENT.md`.

## M8 accepted direction

Source of truth: `docs/MULTI-BACKEND-EXECUTION-ARCHITECTURE.md`.

The new product direction is not merely "give normal Chat local Computer Use." It is to use one ChatGPT Project/chat as a persistent development session that can move between execution targets:

```text
GitHub remote
MAIN-PC local
VMware local
future local machines
```

and local agents:

```text
chatgpt-chat
codex
claude-code
worker
```

Important M8 invariants:

- Backend and Agent are separate concepts.
- The same ChatGPT Project can have a different local folder on every machine.
- GitHub remains a first-class backend and must continue working while local machines are off.
- Local execution provides real files/tests/Computer Use/workers when the selected machine is online.
- The runtime should automatically communicate the current machine/backend to normal Chat; the user should not need to say "I switched to PC 2."
- Conversation continuity does not imply workspace-state continuity.
- Dirty or unpushed state on one machine must never be represented as available on another machine/GitHub.
- Do not replace the current `Project.root` model in the first M8 unit. Add a separate execution/profile layer and versioned state first.
- Do not start by broadly patching the official ChatGPT Windows app. First test whether normal Chat + desktop/local MCP can obtain current ChatGPT Project identity. If not, a thin patch may supply only Project identity/routing/UI context.
- Existing Worker isolation, `/mcp/worker`, leases, Computer Use policy/audit/kill switch, and local path safety remain authoritative.

M8.1 should begin with only the foundational model/store/resolver and focused tests. Do not jump directly to Windows UI patching, auto-push, or cross-machine dirty-tree synchronization.

## How to work with the user

The user prefers implementation-first progress. When they say `진행해`, `이어가자`, or otherwise authorize the next unit, inspect the repository/CI and perform the work in the same turn. Work one coherent unit at a time and use the sequence **implement -> focused tests/full CI -> fix failures -> update progress/handoff/design docs**. Windows/VMware remains the active live-validation environment while Ubuntu/macOS CI must remain healthy.

## Persistent engineering boundaries

Do not weaken these contracts:

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

The opaque `workerToken` remains the authority for a specific worker/worktree. Worker catalog excludes ordinary main file/shell/git tools, plugins, Skills, Agent Manager, and Computer Use. M6.5 revalidated this boundary live while confirming the normal main `/mcp` catalog remained intact.

### Browser worker routing/recovery

The established Worker-app routing remains fail closed: the dedicated app must materialize as the selected entity before bootstrap text is submitted. True target-loss recovery is live-proven both generally and with M6 execution intent: durable `running` worker remained authoritative, lost target reconciled to browser `failed`, same workerId relaunched in attempt 2, the durable execution intent remained unchanged, and a fresh verified execution observation was recorded for the new browser attempt.

M6.3 inserts execution verification before this existing Worker-app flow when a worker has explicit model/reasoning intent. M6.4 keeps the browser attempt's verified observation separate from the durable worker intent so recovery diagnostics do not rewrite worker truth.

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

Live M6.5 account/profile observations:

```text
model label: GPT-5.6 Sol
available reasoning: instant | medium | high
unavailable on this account/profile: extra-high
```

`extra-high` remains a valid runtime adapter key; its current unavailability is a profile/account capability limitation and explicit requests correctly fail closed before task submission.

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

## M6.3 completed contract

M6.3 adds a narrow set-and-verify browser adapter at `src/agents/chrome-execution.ts` and wires the durable intent into both initial browser launch and recovery.

For workers with explicit model/reasoning intent, launch order is:

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

No explicit execution intent means the adapter returns immediately without touching execution controls, preserving legacy behavior. M6.5 confirmed this path remained unmanaged across two browser attempts and still completed normally after lifecycle recovery.

The adapter uses structural picker/composer signals, exact normalized model matching, ARIA reasoning-slider state, and native CDP pointer events followed by fresh observation. A dispatched click is never accepted as success by itself.

M6.5 found one live transient race: after control discovery, a single pointer dispatch did not always materialize the execution menu during parallel launch. Commit `3cb220986a4a9219d239e7638a9184f41cbbc2bf` keeps the same two-second menu observation budget but splits it across two bounded activation attempts, re-observing the execution control before each activation. Focused execution tests and typecheck passed, the post-fix parallel live validation succeeded on attempt 1 for both medium and high workers, and final cross-platform CI run `35172617811` passed.

Implementation/test sequence before live fix: `d5741d07`, `2d15d532`, `7e0cedfd`, `c562e130`, `8960867e`, `43c6afae`, `dd423f59`, `dcc73aba`.
Original M6.3 CI: `35131605738` green on macOS, Ubuntu, and Windows.
Post-M6.5 race fix: `3cb2209`; focused `chrome-execution` 14/14, `chrome-cdp-execution` 2/2, typecheck passed; final M6 CI `35172617811` green on Ubuntu/macOS/Windows.

## M6.4 completed contract

M6.4 makes the execution state inspectable without confusing browser telemetry with durable worker truth.

`BrowserWorkerSession` optionally keeps bounded current-attempt execution diagnostics separately from durable requested/resolved/source metadata. A recovery creates a fresh browser attempt and replaces current-attempt observation without re-resolving the durable intent.

`agent_status` and `agent_result` expose requested/resolved/sources separately from observed/verified/error/attempt when relevant. Workers with neither durable execution intent nor browser execution telemetry retain the concise legacy shape.

Implementation/test sequence: `92827274`, `1a7199ac`, `477bc99c`, `e693b36d`, `a1117d2f`.
Full CI `35132971767` on `a1117d2fd08d57f49aa62d55de7a0b7cd8dd499f`: **green on macOS, Ubuntu, and Windows**.

## M6.5 completed live validation

Detailed evidence is recorded in `docs/M6-LIVE-VALIDATION.md`.

Validated live on the real dedicated Worker profile:

- no-explicit-setting compatibility with no execution telemetry emitted;
- exact live model label `GPT-5.6 Sol`;
- `instant`, `medium`, and `high` selectable and verified;
- `extra-high` unavailable on the current account/profile and correctly fail-closed before task submission;
- two parallel workers carrying different durable intents simultaneously `running` and `verified=true`;
- target-loss recovery preserving the same durable intent while replacing the browser attempt and recording fresh verified observation;
- deliberately nonexistent explicit model failing before task submission with useful bounded diagnostics;
- mapped ChatGPT Project routing;
- Worker `/mcp/worker` catalog/capability isolation and normal main `/mcp` behavior.

M6.5 discovered the transient picker activation race fixed by `3cb2209`; the post-fix parallel live retest passed.

## M6 completion

M6 is complete. Final authoritative CI evidence:

- post-validation HEAD: `5dac24f96bd9ae162ad26a0b29bfeb96883526bd`;
- GitHub Actions run: `35172617811`;
- Ubuntu: success;
- macOS: success;
- Windows: success.

## Runtime/update note

`start-chatgpt.ps1` builds only when `dist/cli.js` is missing. After pulling TypeScript changes on the VM, run `npm run build` before restarting through the known-good runtime path.

## Source-of-truth documents

- `docs/MULTI-BACKEND-EXECUTION-ARCHITECTURE.md` — M8 multi-backend Project/Backend/Machine/Workspace/Agent/State architecture and implementation order.
- `docs/WORKER-EXECUTION-CONFIG-DESIGN.md` — M6 design and implementation order.
- `docs/M6-LIVE-VALIDATION.md` — detailed M6.5 live evidence and final CI.
- `docs/M7-WORKER-PLACEMENT.md` — M7 placement policy, implementation, live validation, and final CI.
- `docs/CUSTOM-RUNTIME-PROGRESS.md` — milestone/history and CI evidence.
- `docs/CUSTOM-RUNTIME-PLAN.md` — architecture/roadmap.
- `docs/CHATGPT-WORKER-APP-SETUP.md` — two-app configuration.
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md` — Project placement vs message-level Worker-app routing.
- `docs/PLUGINS-DESIGN.md` — plugin boundary.
- `docs/SKILLS-DESIGN.md` — Agent Skills lifecycle/security.
- `docs/HOOKS-DESIGN.md` — Hooks semantics.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` — Windows Computer Use boundary.

## Handoff maintenance rule

Keep detailed chronological evidence in `CUSTOM-RUNTIME-PROGRESS.md` and `M6-LIVE-VALIDATION.md`, and detailed execution-configuration design decisions in `WORKER-EXECUTION-CONFIG-DESIGN.md`.

## New-session start procedure

1. Read this file.
2. Check actual `dev/custom-runtime` HEAD and latest CI.
3. Read `docs/CUSTOM-RUNTIME-PROGRESS.md` and the next roadmap unit before making changes.
4. Read `docs/M6-LIVE-VALIDATION.md` only when execution-configuration/live Worker details are relevant.
5. Read `docs/M7-WORKER-PLACEMENT.md` when Worker ChatGPT Project placement/routing is relevant.
6. Read `docs/MULTI-BACKEND-EXECUTION-ARCHITECTURE.md` before starting or changing M8 work.
7. If docs and repo disagree, trust repo and correct the docs.

M6 and M7 core contracts are complete. M8.0 is documentation-only; M8.1 is the next implementation unit. Revalidate M6/M7 only when future ChatGPT UI/account changes or placement-policy changes affect the established behavior.