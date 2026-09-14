# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M3 - Windows Computer Use**

Active unit: **M3.2 - Windows observation**

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
- [x] Add parallel-worker lifecycle/recovery tests and verify them on Ubuntu, Windows, and macOS.
- [x] Add DOM completion fallback when ChatGPT becomes stably idle without calling `worker_finish`.
- [x] Treat DOM text only as diagnostic recovery context; never fabricate a durable completed worker result from it.
- [x] Revoke the stale capability and keep the durable worker/worktree recoverable when the DOM fallback fires.
- [x] Ignore DOM probe/selector failures rather than failing a healthy worker.

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
- `08c206fb` added parallel-worker recovery coverage; CI run `34816999035` passed Ubuntu, Windows, and macOS.
- `056be27c` added recoverable missing-`worker_finish` handling; `a2c2495d` added the stable two-sample ChatGPT DOM probe; `d5de1296` wired it into `agent_status`; `2c4ec1b7` added fallback/recovery regression coverage.
- CI run `34871554912` passed Ubuntu, Windows, and macOS for the DOM completion fallback slice.
- The legacy `agent_cancel` remains the durable-state cancellation primitive. `agent_stop` is currently the Web-worker-aware public path; consolidation can wait until the behavior is proven live rather than widening the older tool implementation now.

### M3.1 - Windows native input backend foundation

- [x] Preserved the existing desktop-control queue, control lease, allowlist/sensitive-target checks, kill switch, approval flow, MCP surface, and audit path.
- [x] Added a persistent Windows-native helper behind `input-backend.ts` instead of creating a second control orchestration stack.
- [x] Added exact app/window resolution and activation with a live foreground re-check before `SendInput`.
- [x] Added coordinate click, Unicode typing without clipboard mutation, and legacy keyCode -> Win32 virtual-key translation.
- [x] Replaced the earlier per-action PowerShell/C# compile path with one persistent JSON-lines helper; the old `win-input.ts` is now only a compatibility re-export.
- [x] Added an explicit helper-ready handshake so slow cold `Add-Type` startup is separated from the normal per-request timeout.
- [x] A wedged request discards the helper instead of reusing an uncertain process; helper handles are unref'd so they do not pin the parent process lifetime.
- [x] Added a Windows CI probe that performs repeated read-only foreground queries and never injects input into the runner desktop.
- [x] CI run `34883979535` passed Windows, Ubuntu, and macOS; Windows passed typecheck, 61 focused tests, and build, including the persistent-helper probe.

Implementation notes:

- `32c857d4` introduced the persistent Windows helper foundation.
- `eac761b0` routed the Windows platform boundary to `win-native.ts`.
- `73997d09` added persistent-helper/key-translation tests and `ac072650` wired them into CI.
- `e6a774ec` retired the one-shot helper implementation behind a compatibility re-export.
- CI run `34883661545` exposed that the first request timer incorrectly included cold PowerShell/C# startup and timed out after 30 seconds on the Windows runner.
- `c34d207e` added the explicit startup-ready handshake plus separate startup/request timeouts; the corrected CI run `34883979535` passed.
- New Computer Use work is Windows-focused. Existing upstream macOS/Linux code remains only where removing it would create needless churn.

## In progress

### M3.2 - Windows observation

- [ ] Add read-only visible top-level window/app enumeration to the persistent helper.
- [ ] Add allowlisted app-window screenshot capture with validation and explicit fallback order.
- [ ] Add DPI/coordinate normalization metadata needed to align screenshots with later actions.
- [ ] Wire Windows screenshot/evidence through the existing privacy/allowlist control path.
- [ ] Add safe CI coverage without capturing unrelated runner desktop content.

## Planned next

### M3.3 - Windows UIA semantic layer

- [ ] Bounded/cached UIA snapshot for the selected allowlisted app/window.
- [ ] Ephemeral semantic element ids scoped to an observation.
- [ ] Invoke/set-value/focus/selection where reliably exposed, with coordinate fallback preserved.

### M3.4 - Computer Use activity indicator

- [ ] Native click-through topmost activity border.
- [ ] Keep the overlay out of model screenshots via capture exclusion or temporary hide fallback.
- [ ] Bind visibility to Computer Use activity only; never use the border as authorization state.

### M3.5 - VMware live smoke validation

- [ ] Notepad/basic text target.
- [ ] Explorer and browser targets.
- [ ] Multi-window focus switching and DPI scaling.
- [ ] Screenshot -> target -> action loop.
- [ ] Activity border click-through and kill/cancel cleanup.
- [ ] Repeated sessions without stale helper/overlay state.

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
