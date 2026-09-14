# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M2 - ChatGPT Web workers**

Active unit: **M2.4 - Worker completion/recovery**

## Completed

### M0 - Baseline

- [x] Fork and `dev/custom-runtime` branch created.
- [x] Baseline preserved against upstream starting point.
- [x] CI established: Ubuntu/Windows typecheck + focused cross-platform tests + build; macOS full test + build.

Key commits: `bac50959`, `53c2d1a4`.

### M1.1 - Durable worker state and inbox

- [x] Durable worker records with `pending/running/completed/failed/cancelled` states.
- [x] Atomic JSON persistence and durable final result/error.
- [x] One-time completion/failure/cancellation notifications without deleting results.
- [x] Invalid IDs and illegal final-state transitions rejected.

Key commits: `8de81ae3`, `072feace`.

### M1.2 - Worker-specific Git worktree isolation

- [x] One branch and one runtime-managed worktree per worker.
- [x] Worktree assignment persisted and verified against the intended repository/base commit.
- [x] Dirty work is preserved; cleanup never force-deletes worker edits.
- [x] Real-Git integration tests pass cross-platform.

Key commits: `6795635d`, `84d34d46`.

### M1.3 - Agent Manager API

- [x] Spawn/status/result/cancel/workspace/wait/ack orchestration.
- [x] Spawn leaves the worker `pending` until a browser worker accepts the task.
- [x] Short event wait uses the durable inbox and does not discard full results.

Key commits: `d680dca3`, `b904a145`.

### M1.4 - MCP agent tools

- [x] `agent_spawn`, `agent_status`, `agent_result`, `agent_wait`, `agent_cancel`, `worker_finish`.
- [x] Full-write lease required for worker preparation.
- [x] `worker_finish` verifies the managed worktree and optional commit SHA.

Key commits: `88b981cb`, `99a61874`, `3052774e`, `0140853b`.

### M1.5 - Completion notification piggyback

- [x] Concise worker completion notices attach to later normal Core MCP results.
- [x] Full results remain durable behind `agent_result`.
- [x] Delivery is bounded and best-effort so Core tool success is never broken by notification failure.

Key commits: `f3b9c80b`, `b0f92638`, `30cb2921`.

### M2.1 - Worker-scoped Core routing

- [x] Opaque worker capabilities with hash-only persistence and revoke/expiry lifecycle.
- [x] Worker-specific in-memory `ToolContext` rooted at the managed worktree.
- [x] Explicit allowlist of reused Core coding handlers.
- [x] Worker calls never mutate the main ChatGPT `sessions.json` active project/lease.
- [x] Capability authorization required for `worker_finish`.

Key commits: `0a47070e`, `3d5886a8`, `66159afa`, `83166838`, `0140853b`.

### M2.2 - Browser worker controller foundation

- [x] Optional local-project -> ChatGPT Project routing state.
- [x] Durable browser-worker state separate from ChatGPT private conversation/request identity.
- [x] Launch/cancel driver boundary with browser failure isolated from Core and worker workspace state.
- [x] Failed launches remain retryable.

Key commits: `e4ee5b39`, `2448e60c`, `33ea1bff`, `15fa47aa`.

### M2.3 - ChatGPT worker launch/bootstrap

- [x] Dedicated Chrome profile and Chrome DevTools Protocol driver.
- [x] Standalone ChatGPT worker tab launch.
- [x] Prefer configured ChatGPT Project route; fall back to standalone when the mapped destination has no usable composer.
- [x] Worker bootstrap explicitly carries the task and scoped worker capability.
- [x] Bootstrap requires worker-scoped repository tools and `worker_finish` at completion.
- [x] Durable worker changes `pending -> running` only after the bootstrap prompt is submitted.
- [x] Launch failure revokes the issued capability, keeps the worker/worktree pending, and supports a fresh retry.
- [x] Added `agent_launch` as the explicit launch/retry step after `agent_spawn`.
- [x] Added `agent_project_route_set/get/clear` for persistent repo -> ChatGPT Project placement.
- [x] Cross-platform tests cover project routing, successful launch, failed launch, and retry.
- [x] CI run `34815713659` passed Ubuntu, Windows, and macOS after the M2.3 changes.

Implementation notes:

- `6f0a4221` added the dedicated Chrome CDP driver.
- `892cf5d5` / `9acd80ca` added durable browser-launch orchestration and tests.
- `bfba691b` added the `agent_launch` MCP tool.
- `9766a1ce` added ChatGPT Project route management tools.
- `820a4091` registered the Web-agent tool surface with the MCP server.
- `09b40e01` added Web-agent MCP tests; `92047af8` fixed the type mismatch found by CI.
- The current launch contract is intentionally two-step: `agent_spawn` prepares the isolated durable worker/worktree; `agent_launch` opens/submits the Web worker. A normal parent agent should call them back-to-back. This keeps browser retry independent from workspace creation.
- Real Windows/Chrome smoke testing still requires signing in once to the dedicated worker Chrome profile; automated CI uses the driver boundary rather than a live ChatGPT account.

## In progress

### M2.4 - Worker completion/recovery

- [x] Keep `worker_finish` as the primary completion handshake and durable result source of truth.
- [x] Add `agent_stop` to revoke worker access, stop the Web-worker tab when possible, cancel the durable worker, and preserve its branch/worktree/partial edits.
- [x] Browser shutdown failure cannot prevent durable cancellation; it is returned separately as a warning.
- [x] After successful `worker_finish`, retire the browser tab best-effort without changing the already-stored completion result.
- [x] Browser-retirement failure after `worker_finish` is recorded in browser state but cannot turn durable completion into an error.
- [x] Reconcile browser target liveness on `agent_status` without a background browser poller.
- [x] If the CDP target is lost, revoke its old capability and mark only the browser session failed; keep the durable worker/worktree running and recoverable.
- [x] Reuse `agent_launch` to recover a running worker in a fresh browser attempt with a new capability.
- [x] Refuse recovery while an existing browser attempt is still live/non-final, preventing duplicate worker tabs.
- [ ] Add DOM completion detection only as a fallback when the worker fails to call `worker_finish`.
- [ ] Add parallel-worker lifecycle/recovery tests.

Implementation notes:

- `32e74b45` added the Web-worker `agent_stop` path; `b667d6aa` corrected browser-stop failure reporting.
- `62db0cbb` registered the stop tool and `5831ca83` added lifecycle/capability/worktree-preservation coverage.
- CI run `34816004399` passed Ubuntu, Windows, and macOS for the stop/cancel slice.
- `5feeb9ce` added the `worker_finish` browser cleanup wrapper; `8cfb7754` installs it after durable agent tools are registered.
- `764b78d6` verifies both successful tab retirement and the invariant that a browser-close failure never loses a completed durable result.
- CI run `34816248554` passed Ubuntu, Windows, and macOS for the completion-retirement slice.
- `a73fa36d` added generic browser-target reconciliation and capability revocation; `2266225a` added the no-side-effect dedicated-Chrome target probe.
- `bed891fb` added fresh-tab recovery for a durable running worker; `04f7707c` made `agent_launch` select initial launch versus recovery.
- `393db8e5` attaches browser reconciliation to the existing `agent_status` tool; `b87ad8f0` covers target loss, token revocation, and attempt-2 recovery.
- Initial recovery CI run `34816631482` exposed a real regression in the pre-existing cancellation race: the refactored launch helper no longer closed a tab if the durable worker was cancelled between browser submission and `pending -> running`. `1efec18f` restored cleanup around that transition instead of weakening the race test.
- `afe55336` added a local CDP target-probe test that does not start Chrome. CI run `34816770765` passed Ubuntu, Windows, and macOS for the corrected recovery slice.
- The legacy `agent_cancel` remains the durable-state cancellation primitive. `agent_stop` is currently the Web-worker-aware public path; consolidation can wait until the behavior is proven live rather than widening the older tool implementation now.

## Planned next

### M3 - Windows Computer Use

- [ ] Windows-native desktop control for the VMware environment.

### M4 - Hooks

- [ ] Hook engine.
- [ ] `SessionStart`.
- [ ] `PreToolUse` / `PostToolUse`.
- [ ] `SubagentStart` / `SubagentStop`.
- [ ] Ponytail-style integration after hook semantics stabilize.

### M5 - Plugins

- [ ] Separate optional Plugins connector.
- [ ] External MCP discovery/configuration.
- [ ] Failure isolation from Core.

## Update policy

Update this file whenever a unit is completed, blocked, materially redesigned, or moved in scope. Record verification and relevant commits before beginning the next unit.
