# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M1 - Local multi-agent runtime**

Active unit: **Worker-specific Git worktree isolation**

## Completed

### M0 - Baseline

- [x] Fork: `minbang930/chatgpt2codex`
- [x] Development branch: `dev/custom-runtime`
- [x] Confirmed fork baseline matches upstream starting point.
- [x] Added CI baseline.
- [x] Cross-platform typecheck/build on Ubuntu and Windows.
- [x] Full test suite + build on macOS.
- [x] Preserved original runtime behavior while adapting CI to existing platform-specific tests.

Relevant commits:

- `bac50959017aef61eac9625778cc97d8597a15d5` - initial baseline CI
- `53c2d1a4cb531f6bf8338936b58e0b07b391b45f` - split CI by platform capabilities

### M1.1 - Durable worker state and inbox

- [x] Added `src/agents/store.ts`.
- [x] Worker states: `pending`, `running`, `completed`, `failed`, `cancelled`.
- [x] Atomic worker JSON persistence under runtime state.
- [x] Completion/failure/cancellation event persisted with final state.
- [x] Durable result remains available after notification is marked delivered.
- [x] Idempotent repeat completion does not create duplicate events.
- [x] Invalid/traversal worker and event IDs are rejected.
- [x] Final workers cannot transition back to running or to another final state.
- [x] Unit tests added.
- [x] CI green on Ubuntu, Windows, and macOS after implementation.

Relevant commits:

- `8de81ae3b9c8a3c2f0868d0bb0375b28881d5f2e` - durable worker state and completion inbox
- `072feace2ed4359dd52d13ced2159ce0409146aa` - worker store tests

## In progress

### M1.2 - Worker-specific Git worktree isolation

Target behavior:

- [x] Create one branch per worker.
- [x] Create one worktree per worker.
- [x] Keep worker worktrees under runtime-managed state, not inside the user's main checkout.
- [x] Persist worker branch/worktree assignment in the worker record.
- [x] Verify the worktree points at the intended repository and base commit.
- [x] Make creation safe/idempotent enough for retries.
- [x] Refuse arbitrary worker/worktree paths.
- [x] Add cleanup primitives without deleting work by default.
- [x] Add real-Git integration tests.
- [ ] Pass final CI verification.

Implementation notes:

- `6795635d6d70f4cc59216301b397954746110dae` added managed worker worktrees, persisted workspace metadata, safe cleanup, and real-Git tests.
- The first macOS run exposed the `/var/...` vs `/private/var/...` alias returned by `realpath`/Git worktree metadata. The runtime correctly refused the mismatch rather than guessing.
- `84d34d46fffdd657c6dc8b02ed1b15668b4a49d1` canonicalizes existing managed paths before comparison so the same physical worktree is recognized without weakening path confinement.
- Cross-platform CI now runs the isolated `src/agents` tests on Ubuntu and Windows in addition to typecheck/build; macOS still runs the complete suite.

## Planned next

### M1.3 - Agent Manager API

- [ ] Spawn worker record + isolated workspace.
- [ ] Status/result retrieval.
- [ ] Cancellation.
- [ ] Short event wait.

### M1.4 - MCP agent tools

- [ ] `agent_spawn`
- [ ] `agent_status`
- [ ] `agent_result`
- [ ] `agent_wait`
- [ ] `agent_cancel`
- [ ] `worker_finish`

### M1.5 - Completion notification piggyback

- [ ] Attach concise worker completion notices to subsequent normal Core MCP results.
- [ ] Deliver each event once while retaining full result in durable storage.
- [ ] Keep piggyback payload small and non-blocking.

### M2 - ChatGPT Web workers

- [ ] Browser worker controller.
- [ ] Worker tab creation/task bootstrap.
- [ ] Opaque local worker identity handoff.
- [ ] `worker_finish` primary completion handshake.
- [ ] DOM completion detection as fallback only.
- [ ] Parallel worker tests.

### M3 - Windows Computer Use

- [ ] Windows-native desktop control for the VMware environment.

### M4 - Hooks

- [ ] Hook engine.
- [ ] `SessionStart`.
- [ ] `PreToolUse` / `PostToolUse`.
- [ ] `SubagentStart` / `SubagentStop`.
- [ ] Ponytail-style integration after semantics stabilize.

### M5 - Plugins

- [ ] Separate optional Plugins connector.
- [ ] External MCP discovery/configuration.
- [ ] Failure isolation from Core.

## Known baseline notes

The original test suite contains desktop-control tests whose behavior is platform-specific. Running the complete suite on Ubuntu/Windows produces failures unrelated to custom-runtime changes, including macOS-only synthetic input/accessibility expectations. CI therefore uses:

```text
Ubuntu:   typecheck + agent tests + build
Windows:  typecheck + agent tests + build
macOS:    typecheck + full test + build
```

This is a baseline characteristic, not a custom-runtime regression.

## Update policy

Update this file whenever a unit is completed, blocked, materially redesigned, or moved in scope. Record the verification result and relevant commit(s) before beginning the next implementation unit.
