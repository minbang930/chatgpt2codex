# Session Handoff

Operational handoff for continuing `chatgpt2codex` across ChatGPT sessions. Verify this file against the live repository and current CI before making changes; the repository is authoritative when they disagree.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: stable ChatGPT-Web-driven coding runtime without depending on local Codex quota while preserving Core authorization/project/file/shell/git boundaries.

## Current phase

The original M0-M5 roadmap and the blocking post-M5 stabilization work are complete enough to begin the next milestone.

The only previous stabilization item left open is a **non-blocking natural-use observation**: eventually cross the original 30-minute local-control TTL during ordinary use and confirm there is no `LEASE_REQUIRED` regression. Renewal is already covered by code/CI, so do not delay M6 or force a 30-minute wait just to close this observation.

### Active milestone: M6 - Worker Execution Configuration

Design/source of truth:

- `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`

Purpose: let the runtime explicitly control and verify the ChatGPT Web model and reasoning effort used by browser workers instead of silently inheriting whatever state the dedicated worker Chrome profile currently has.

M6 implementation order:

1. **M6.1 - Execution settings foundation**
2. **M6.2 - Durable per-worker execution intent**
3. **M6.3 - ChatGPT Web model/reasoning set-and-verify adapter**
4. **M6.4 - Status/diagnostics**
5. **M6.5 - Live validation**

Do one unit at a time. Do not jump directly to UI automation before M6.1/M6.2 establish configuration and durable-state contracts.

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
- The desktop-control kill switch is independent from lease renewal. Renewal must never clear a kill; a fresh local control grant is still required after a kill.
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

The runtime currently does **not** own model/reasoning selection. M6 fixes that without changing worker authorization.

Required precedence:

```text
per-worker override
    > project default
    > global default
    > no explicit preference / current ChatGPT state
```

Required durable behavior:

- resolve explicit execution intent when the worker is created;
- persist that resolved intent with the durable worker;
- recovery reuses the same persisted intent even if global/project defaults later change.

Required browser behavior:

```text
observe current model/reasoning
 -> apply requested change if needed
 -> observe again
 -> verify requested == observed
 -> only then select Worker app and submit bootstrap
```

A model/reasoning picker click is not proof of success. Explicit settings should fail closed by default if they cannot be verified. Details and implementation units are in `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.

## Active unit

**M6.1 - Execution settings foundation.**

Before writing code, inspect the current worker record schema, Agent Manager spawn path, browser session schema, MCP registration/lease patterns, and `src/agents/chrome-cdp.ts`.

M6.1 should add only:

- normalized worker execution preference/intent types;
- versioned global/project settings persistence;
- fixed main-agent get/set/clear settings tools;
- deterministic precedence/resolution helpers;
- focused compatibility/validation tests.

M6.1 must **not** automate the ChatGPT model/reasoning UI yet.

Exit criterion: worker execution settings can be configured and resolved deterministically without changing existing browser launch behavior.

## Runtime/update note

`start-chatgpt.ps1` builds only when `dist/cli.js` is missing, not whenever `src` is newer. After pulling source changes that touch TypeScript runtime code on the VM, run `npm run build` before restarting. PowerShell-only launcher changes do not require a TypeScript rebuild.

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
5. Read the current-status/current-queue portion of `docs/CUSTOM-RUNTIME-PROGRESS.md`.
6. If docs and repo disagree, trust repo and correct the docs.
7. If they match, implement **M6.1 only** and take it through focused tests + full CI before moving to M6.2.

A future user message consisting only of **`SESSION-HANDOFF.md 읽고 M6 이어서 진행해`** should be enough to resume.
