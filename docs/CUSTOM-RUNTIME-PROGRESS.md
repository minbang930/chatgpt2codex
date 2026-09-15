# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M4 - Hooks**

Active unit: **M4.2 - SessionStart integration**

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

### M3.2 - Windows observation

- [x] Added read-only visible top-level window enumeration to the persistent helper using Win32 `EnumWindows`/window metadata.
- [x] Returned observation-scoped `window-N` ids only; native HWND values never leave the helper and are never accepted as later action authority.
- [x] Bounded enumeration to 200 visible, titled, positive-size top-level windows and kept the hot path process-local to avoid expensive executable metadata lookup per window.
- [x] Added per-window DPI and scale-factor metadata with a DPI-aware helper process.
- [x] Added explicit allowlisted app-window screenshot capture for Windows.
- [x] App capture prefers `PrintWindow(PW_RENDERFULLCONTENT)` and validates the frame; an invalid/solid capture falls back to an exact-target foreground + screen-region copy.
- [x] Added a platform capture adapter so the existing `computer_screenshot` tool uses Windows app capture without creating a second privacy/control path.
- [x] Windows unrestricted full-screen capture remains disabled; ChatGPT-exposed capture still requires an explicit allowlisted `appName`.
- [x] Request-time Windows actions now include the same live frontmost-app allowlist/sensitive-target check as the executor-time gate.
- [x] Added Windows before/after action evidence through the same app-window capture adapter; evidence remains best-effort and cannot block the action itself.
- [x] Added CI-safe coverage for enumeration/DPI and capture IPC failure on a deliberately nonexistent target, without capturing unrelated runner desktop content.
- [x] CI run `34886165392` passed Windows, Ubuntu, and macOS after the complete M3.2 integration; Windows passed typecheck, focused tests (including the persistent helper) and build.

Implementation notes:

- `13c8cb31` added the first read-only Win32 window observation path; `cd34889e` exposed it at the platform boundary and `065d2a37` added enumeration tests.
- CI run `34884963306` showed two real performance problems on hosted Windows: cold helper compilation exceeded the test budget and per-window executable-description lookup made `listWindows` exceed its request timeout.
- `8077897d` gave the one-time helper compile its existing startup budget, while `eb83c2a3` removed expensive `MainModule.FileVersionInfo` lookup from the enumeration hot path; CI run `34885431082` then passed.
- `54a4f7ba` added DPI-aware `PrintWindow`/screen-region app capture; `817133ea` added DPI and safe capture-wiring coverage.
- `ce78688e` added the platform control capture adapter, `c5cc4fd1` wired it into `computer_screenshot` and the Windows request-time target gate, and `9785a1c9` enabled Windows before/after action evidence.
- Actual image-content quality, GPU-heavy windows, multi-monitor behavior, and screenshot-to-action interaction remain intentionally deferred to M3.5 live VMware validation; CI validates the control/capture plumbing without reading the hosted runner desktop.

### M3.3 - Windows UIA semantic layer

- [x] Added a bounded Windows ControlView snapshot for the selected allowlisted app window: at most 120 returned elements, depth 8 by default (hard max 10), and at most 800 visited nodes.
- [x] Added a separate persistent UIA helper with an eight-observation, two-minute cache so slow/broken UIA providers cannot wedge the M3.1 SendInput helper.
- [x] Added ephemeral `uiaobs_*` observation ids and `uiael_*` element ids; no HWND or UIA runtime id is exported or accepted as later authority.
- [x] Every returned element includes an opaque observation-scoped `selector` that reuses the existing `target.ax` wire shape, avoiding a second Windows-only MCP action schema.
- [x] UIA snapshots expose only bounded metadata (name/AutomationId/class/control type/bounds/pattern availability); current ValuePattern contents are never read or returned.
- [x] Semantic click chooses `InvokePattern`, then `SelectionItemPattern.Select`, then `SetFocus` where supported.
- [x] Semantic type focuses and uses writable `ValuePattern.SetValue`; the existing executor preserves windowPoint click/type fallback when UIA is unavailable or stale.
- [x] Semantic actions re-resolve the element against the current app window immediately before actuation using AutomationId/name + control type/class/bounds, and reject observations if the target process changed.
- [x] Request-time semantic preview is read-only; actual semantic input still travels through the existing control lease, allowlist/sensitive-target gates, approval queue, kill switch, executor, evidence, and audit path.
- [x] App-targeted Windows `computer_screenshot` now returns `semanticObservation` best-effort after the authorized screenshot; UIA failure never prevents coordinate-based Computer Use.
- [x] Added CI-safe coverage that loads the Windows UIA stack and exercises a deliberately nonexistent target without observing or modifying unrelated runner desktop content.
- [x] CI run `34887653677` passed Windows, Ubuntu, and macOS; Windows passed typecheck, focused tests including both Windows helpers, and build.

Implementation notes:

- `b31ebc41` added the isolated persistent UIA helper, bounded traversal/cache, scoped selectors, re-resolution, Invoke/Selection/Focus, and ValuePattern support.
- `79e31c86` routed Windows semantic resolution/press/value operations through the existing platform boundary while leaving macOS AX behavior unchanged.
- `362804cf` coupled the semantic snapshot to the already-authorized Windows app screenshot and added Windows request-time semantic preview.
- `5c2844a7` added opaque-selector and safe helper-start coverage; `c68f4e92` added that coverage to cross-platform CI.
- Keeping UIA in its own helper is intentional failure isolation, not a second control orchestration stack: UIA provider hangs kill only the UIA helper, while the existing queue/executor/SendInput and coordinate fallback remain available.
- Actual Notepad/Explorer/Chrome semantics, stale-element behavior under live UI changes, and screenshot-to-semantic-action quality remain intentionally deferred to M3.5 VMware validation.

### M3.4 - Computer Use activity indicator

- [x] Added a Windows-native topmost activity border around every display plus a small primary-display `Computer Use` badge.
- [x] Overlay windows are `TOOLWINDOW + NOACTIVATE + TRANSPARENT`, return `HTTRANSPARENT`, stay out of Alt+Tab/taskbar, and never take keyboard focus or pointer input.
- [x] Added `WDA_EXCLUDEFROMCAPTURE` on every overlay window and a capture-time hide/restore fallback so model screenshots do not contain the activity UI even when a VM/capture path ignores display affinity.
- [x] Bound the indicator only to actual Windows screenshot/input/UIA actuation scopes; read-only observation, target resolution, approval state, and permission remain independent.
- [x] Added overlapping-scope reference counting and a short idle debounce so screenshot/evidence/input sub-steps share one stable indicator instead of flickering.
- [x] Kept the visual helper failure-isolated from SendInput/UIA: overlay startup/render failure is cosmetic and cannot authorize, block, or fail a Computer Use action.
- [x] Added a parent-process watchdog so an orphaned overlay helper exits if the runtime disappears.
- [x] Added CI-safe lifecycle/suppression tests plus a Windows compile-only native helper probe that never shows an overlay on the hosted runner.
- [x] CI run `34888805540` passed Windows, Ubuntu, and macOS; Windows passed typecheck, focused tests including the native activity-helper probe, and build.

Implementation notes:

- `22e0773f` added the persistent Windows activity helper and reference-counted activity manager.
- `14cdef8d` bound coordinate, key, and UIA actuation to the indicator; `bdedb955` added screenshot activity plus capture-time suppression.
- `e68b7eaa` added lifecycle/suppression/native-probe tests and `a9481377` added them to cross-platform CI.
- The border is intentionally cosmetic: it never represents control permission or approval. Live click-through, visual appearance, multi-monitor behavior, and kill/cancel cleanup remain part of M3.5 VMware validation.

### M3.5 - VMware live smoke validation

- [x] Notepad/basic text target: semantic observation, semantic input, and coordinate fallback validated on the interactive Windows VM.
- [x] Explorer and browser targets: Explorer selection and Chrome address-bar/UIA interaction validated without widening the allowlist/control model.
- [x] Multi-window focus switching and DPI scaling validated at 125% (`dpi=120`, `scaleFactor=1.25`) and 150% (`dpi=144`, `scaleFactor=1.5`).
- [x] Screenshot -> target -> action loop validated, including minimized Notepad observation and a final live `windowPoint` click after the native activation fixes.
- [x] Activity glow/click-through, screenshot exclusion, and local Esc cancellation validated; Esc cancels only the active Computer Use operation and does not trip the kill switch.
- [x] Repeated runtime/session restart behavior validated without stale helper/overlay state.

Implementation notes:

- Minimized Notepad returned a live `semanticObservation` with 29 elements and no `semanticWarning` after aligning minimized-window handling between the native and UIA helpers.
- The activity indicator was iterated from a hard border prototype to a subtle multi-band edge glow; pointer/halo/ripple experiments were later removed from the final indicator path.
- Screenshot captures were verified not to contain the visible Computer Use glow/indicator.
- `2111ca6` made the Windows launcher/runtime re-read persisted Cloudflare tunnel settings from Process/User/Machine scope so the fixed `c2c.minbang.email` Named Tunnel does not silently fall back to the wrong hostname path.
- `308d5aa` corrected `GetCurrentThreadId` to import from `kernel32.dll`; the previously failing coordinate-click path then succeeded in the live VM.
- CI run `34925521385` passed Windows, Ubuntu, and macOS for the final M3 tunnel/native-input fixes.

### M4.1 - Hook engine foundation

- [x] Added a versioned hook configuration at runtime-owned `<stateDir>/hooks.json`.
- [x] Defined the initial lifecycle vocabulary: `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`, and `SubagentStop`.
- [x] Added a direct-argv command hook driver with `shell:false`, the existing restricted child environment, and a JSON event envelope delivered on stdin.
- [x] Added bounded working-directory modes (`project`, `workspace`, `state`) instead of arbitrary configured cwd paths.
- [x] Added sequential deterministic execution, per-hook timeout/process-tree termination, bounded stdout/stderr capture, and config/output limits.
- [x] Hook/config/spawn/exit/timeout failures are reported but never throw through a healthy Core caller; one failed hook does not prevent later hooks from running.
- [x] Repository-controlled hook files are not auto-loaded or auto-executed.
- [x] Added cross-platform tests for missing/invalid config, stdin envelope/cwd, failure isolation, timeout, and repository-config non-execution.
- [x] Added `docs/HOOKS-DESIGN.md` defining the generic M4 contract before Ponytail-specific behavior is introduced.
- [x] CI run `34927688256` passed Ubuntu, Windows, and macOS, including Windows native/UIA/activity helper regression coverage and the Windows launcher build.

Implementation notes:

- `src/hooks/engine.ts` contains the M4.1 engine; `src/hooks/engine.test.ts` covers the foundation contract.
- `57afd780` corrected a TypeScript Buffer-generic mismatch exposed by CI without changing runtime semantics.
- `dd1925a` made the hook cwd test compare real paths so macOS `/var` versus `/private/var` aliases do not create a false failure.
- `a9099de` gave one pre-existing Windows DOM-recovery test a 10-second budget after hosted Windows setup exceeded its old 5-second test timeout; this was test-only and did not change browser-worker production behavior.
- M4.1 intentionally defines the event names but does not yet emit them from runtime lifecycle points. Event wiring begins in M4.2.

## In progress

### M4.2 - SessionStart integration

- [ ] Emit `SessionStart` once for each newly created MCP session/server instance.
- [ ] Keep the event payload bounded and free of secrets/tool arguments.
- [ ] Resolve the current active project only for hook context/cwd and minimal event metadata.
- [ ] Hook failure or malformed configuration must never prevent stdio/HTTP MCP session startup.
- [ ] Add stdio/HTTP-safe unit coverage and cross-platform CI verification.

## Planned next

### M4.3 - Tool lifecycle hooks

- [ ] Add `PreToolUse` / `PostToolUse` at the shared MCP tool boundary rather than duplicating wiring inside every handler.
- [ ] Keep payloads bounded to tool name/project/success/duration metadata by default.
- [ ] Preserve the M4.1 best-effort/non-veto contract.

### M4.4 - Subagent lifecycle hooks

- [ ] Add `SubagentStart` when a durable Web worker actually enters its accepted/running lifecycle.
- [ ] Add `SubagentStop` once when the worker reaches or is forced into a final/retired lifecycle state.
- [ ] Keep durable worker state as the source of truth; hooks are notifications only.

### M4.5 - Ponytail-style integration

- [ ] Add Ponytail-compatible behavior only after generic hook timing/payload/failure semantics are stable.

### M5 - Plugins

- [ ] Separate optional Plugins connector.
- [ ] External MCP discovery/configuration.
- [ ] Failure isolation from Core.

## Update policy

Update this file whenever a unit is completed, blocked, materially redesigned, or moved in scope. Record verification and relevant commits before beginning the next unit.