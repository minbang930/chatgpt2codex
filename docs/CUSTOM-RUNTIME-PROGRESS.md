# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M7 - Worker Placement Policy — complete**

Active unit: **M7 complete; select the next roadmap unit before implementation**

Primary operational handoff: `docs/SESSION-HANDOFF.md`.
Detailed live-validation records: `docs/M6-LIVE-VALIDATION.md` and `docs/M7-WORKER-PLACEMENT.md`.

Detailed design documents:

- `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md`
- `docs/HOOKS-DESIGN.md`
- `docs/SKILLS-DESIGN.md`
- `docs/PLUGINS-DESIGN.md`
- `docs/CHATGPT-WORKER-APP-SETUP.md`
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md`

## Completed roadmap

### M0 - Baseline

- [x] Fork and `dev/custom-runtime` branch created.
- [x] Baseline preserved against upstream starting point.
- [x] Cross-platform CI established for typecheck/tests/build, with Windows launcher/native-helper coverage.

Representative commits: `bac50959`, `53c2d1a4`.

### M1 - Local multi-agent runtime

- [x] Durable `pending/running/completed/failed/cancelled` worker records and durable completion inbox.
- [x] One isolated managed Git branch/worktree per worker.
- [x] Agent Manager spawn/status/result/cancel/workspace/wait/ack APIs.
- [x] MCP tools: `agent_spawn`, `agent_status`, `agent_result`, `agent_wait`, `agent_cancel`, `worker_finish`.
- [x] Completion notification piggyback without discarding durable results.
- [x] Worker orchestration authority split from parent direct-write authority.

Representative commits: `8de81ae3`, `6795635d`, `d680dca3`, `88b981cb`, `f3b9c80b`.

### M2 - ChatGPT Web workers

- [x] Opaque worker capabilities with hash-only persistence, expiry, and revocation.
- [x] Worker-specific Core context rooted at the managed worktree.
- [x] Durable browser-worker state separate from ChatGPT conversation identity.
- [x] Dedicated Chrome profile + local CDP worker launch/bootstrap.
- [x] Optional local project -> ChatGPT Project routing.
- [x] `pending -> running` only after successful bootstrap submission.
- [x] Dedicated Worker custom app backed by `/mcp/worker`.
- [x] Worker-only MCP catalog and exact OAuth resource/audience isolation from main `/mcp`.
- [x] Current ChatGPT role-less app picker and inline selected-app entity support.
- [x] Exact stale Worker-app draft cleanup without erasing arbitrary drafts.
- [x] `worker_finish` remains the only durable completion source of truth.
- [x] Lost browser targets revoke old worker capability without fabricating durable worker failure.
- [x] Same durable running worker can be recovered in a fresh browser attempt.
- [x] DOM completion remains fallback-only and never fabricates a completed durable result.

Representative commits: `0a47070e`, `e4ee5b39`, `6f0a4221`, `32e74b45`, `f2d03f0e`, `a9888c70`, `87f497f0`, `236994e7`, `6179841e`, `95375f7`, `5b16988d`.

### M3 - Windows Computer Use

- [x] Native `SendInput` helper and exact foreground-target verification.
- [x] Coordinate click, Unicode typing, key translation.
- [x] Window screenshot capture with DPI/scale metadata and privacy gates.
- [x] Windows UIA semantic observation/action layer with coordinate fallback.
- [x] Topmost click-through/no-activate activity indicator with screenshot exclusion.
- [x] VMware live smoke across Notepad, Explorer, Chrome, minimized windows, and 125%/150% DPI.
- [x] Pointer/halo/ripple experiments removed; subtle edge glow retained.
- [x] Named Cloudflare tunnel environment-scope lookup and Windows native-input integration fixes validated.

Representative final M3 CI: `34925521385`.

### M4 - Hooks

- [x] Runtime-owned versioned `hooks.json`.
- [x] `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`.
- [x] Direct argv hook execution with bounded cwd/time/output and restricted environment.
- [x] Hook failures are best-effort and never become authorization.
- [x] Ponytail worker integration remains an instruction adapter rather than an authorization layer.

Final M4 CI: `34984722276`.

### M5 - Extensions

- [x] Agent Skills discovery with global/project roots and project precedence.
- [x] Managed local/Git skill install/update/remove with provenance.
- [x] Progressive skill activation with bounded catalog/body sizes.
- [x] Bounded resource reads from references/templates/assets; scripts never auto-run.
- [x] Static external-skill security scan and trust classification.
- [x] External MCP plugin registry/client/lifecycle with HTTPS/loopback constraints.
- [x] Plugin `skillSources` integrated through the normal Skill lifecycle.
- [x] Plugins remain main-agent only and do not enlarge Worker capability/tool registration.

Representative CI: `34993848469`, `34995875346`, `34998597354`, `35011189776`, `35013285118`, `35014499804`.

## Post-M5 stabilization completed

### Hard Worker MCP identity/catalog boundary

- [x] Main custom app remains on `/mcp`.
- [x] Worker custom app uses `/mcp/worker`.
- [x] Worker catalog is exactly `worker_finish` plus `worker_*` mirrors derived from `WORKER_CORE_TOOL_NAMES`.
- [x] Worker endpoint excludes normal main/plugin/Skill/Agent Manager/Computer Use tools.
- [x] OAuth audiences and MCP sessions are role-bound; cross-route replay is rejected.

Implementation/test HEAD `87f497f0`; CI `35017393064` green.

### Browser Worker app selection stabilization

- [x] Subtitle-aware app-row matching.
- [x] Real inline selected-app entity detection inside the composer.
- [x] Current role-less `.popover .__menu-item` picker support.
- [x] Narrow stale plain-text Worker-app mention cleanup.
- [x] Fail-closed behavior when the dedicated Worker app is unavailable.
- [x] Post-click selected-entity verification prevents false-positive picker clicks from being accepted as success.

Relevant commits: `415b8e3`, `5c886bb`, `6179841e`, `95375f7`, `5b16988d`, `7c3bf2c4`, `ae3b5b8b`, `9d036fcf`, `02ab05c3`.

### Connected Worker-app initial completion path

- [x] Dedicated Worker app completed OAuth and exposes only the worker catalog.
- [x] Fresh worker transitioned to `running` through the Worker app, called `worker_finish`, produced an `agent_wait` event, and returned the durable result through `agent_result`.

### Control-preserving Worker orchestration

- [x] Dedicated `worker` lease capability separates worker orchestration from parent direct-write authority.
- [x] `control = read + control + worker`; `full-write = read + verify + write + image + remote + worker`.
- [x] Parent remained on `control` during a live `agent_spawn -> agent_launch -> agent_wait -> agent_result` smoke.

CI `35053101356` green across Ubuntu/macOS/Windows.

### True running-worker browser recovery — live complete

- [x] Worker `wrk_7270a415-1519-4f9e-905c-5d221c63266a` was live-recovered after only its Worker browser tab was manually closed.
- [x] Durable worker stayed `running`, browser reconciled to `failed`, attempt 2 reused the same workerId, and completion remained normal/durable.
- [x] Terminal workers no longer advertise `recoverable=true`; recovery is offered only for durable `running` workers with browser `failed/stopped`.

### Rolling local control authorization — code/CI and live coexistence complete

- [x] Durable `controlLease` is separate from the normal active lease.
- [x] Local control authorization survives normal preset changes and transparently renews only `read`, `control`, and `worker` authority.
- [x] Remote `/mcp` still cannot mint control and renewal never clears the desktop-control kill switch.
- [x] Live VMware: `c2c-smoke` was switched to `full-write`, then Notepad screenshot succeeded using the existing local control authorization without re-selecting `control`.

Code CI `35090954861` green on macOS, Ubuntu, and Windows. The exact 30-minute wall-clock expiry remains a non-blocking natural-use observation.

### Direct Windows named-tunnel hostname reuse — code/CI and live complete

- [x] `start-chatgpt.ps1` reuses saved launcher hostname only when web/named-tunnel exposure is already requested.
- [x] Direct launch with only `-ActiveProjectRoot` derives a compatible workspace.
- [x] Early server exit surfaces stderr instead of only a generic readiness timeout.
- [x] Live VMware launch reached `ChatGPT To Codex is ready` without manually supplying `-PublicHostname`.

CI `35111157222` green on macOS, Ubuntu, and Windows.

## M6 - Worker Execution Configuration — complete

Design/source of truth: `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.
Detailed live evidence: `docs/M6-LIVE-VALIDATION.md`.

### M6.1 - Execution settings foundation — complete

- [x] Added normalized `WorkerExecutionPreference` / `WorkerExecutionIntent` contracts.
- [x] Initial reasoning keys are `instant | medium | high | extra-high`; model remains a normalized string target owned by the browser adapter.
- [x] Added `fallbackPolicy = fail-closed | allow-current` with automatic `fail-closed` when model/reasoning resolves explicitly without a configured policy.
- [x] Added deterministic per-field precedence `worker > project > global` with source metadata.
- [x] Added versioned atomic persistence at `<stateDir>/agents/worker-execution-settings.json` for one global default and optional project overrides.
- [x] Missing settings state preserves the legacy unmanaged/current-ChatGPT behavior.
- [x] Added main-agent-only `worker_execution_settings_get`, `worker_execution_settings_set`, and `worker_execution_settings_clear`.
- [x] Global/project mutations reuse the existing `worker` capability; no new authorization primitive was added.
- [x] The new settings tools are not registered on `/mcp/worker`.

Implementation sequence: `f3a763f0`, `418495d1`, `19a4ff65`, `451dab05`, `ff568723`, `fdc9c6af`.
Full CI `35125045144`: green on macOS, Ubuntu, and Windows.

### M6.2 - Durable per-worker intent — complete

- [x] `agent_spawn` accepts an optional normalized `execution` override without changing existing callers.
- [x] Global/project/per-worker execution preferences are resolved before durable worker creation.
- [x] Requested/resolved/source metadata is persisted as optional `WorkerRecord.executionIntent` before browser launch.
- [x] Older/no-settings workers remain compatible.
- [x] Initial launch and running-worker recovery reuse the same durable intent without re-resolving mutable defaults.

Implementation/test sequence: `b234c58f`, `ff13722c`, `9e5de414`, `da5a10ca`, `c3017969`, `ecb1f076`.
Full CI `35129481274`: green on macOS, Ubuntu, and Windows.

### M6.3 - ChatGPT Web model/reasoning set-and-verify adapter — complete

- [x] Narrow `chrome-execution.ts` adapter owns structural picker/slider interaction.
- [x] Model/reasoning interactions use native CDP events followed by fresh structural verification.
- [x] `fail-closed` blocks Worker-app/bootstrap submission when requested execution cannot be verified.
- [x] No explicit model/reasoning preference preserves the legacy unmanaged/current-ChatGPT path.
- [x] Initial launch and recovery receive the exact durable execution intent.
- [x] Live transient menu-activation race fixed by `3cb220986a4a9219d239e7638a9184f41cbbc2bf`: 2 bounded activation attempts, fresh control observation, unchanged total two-second menu-observation budget.

Original M6.3 CI `35131605738`: green on macOS, Ubuntu, and Windows.
Post-fix focused checks: `chrome-execution` 14/14, `chrome-cdp-execution` 2/2, typecheck passed.
Final M6 CI `35172617811`: green on Ubuntu, macOS, and Windows.

### M6.4 - Status and diagnostics — complete

- [x] Attempt-scoped browser execution observation remains separate from durable `WorkerRecord.executionIntent`.
- [x] `agent_status`/`agent_result` expose requested/resolved/sources separately from observed/verified/error/attempt.
- [x] Recovery replaces attempt-scoped observation without changing durable intent.
- [x] Unmanaged workers retain concise legacy output with no empty execution object.

Implementation/test sequence: `92827274`, `1a7199ac`, `477bc99c`, `e693b36d`, `a1117d2f`.
Full CI `35132971767`: green on macOS, Ubuntu, and Windows.

### M6.5 - Live validation — complete

- [x] Legacy/no-explicit-setting worker path remained unmanaged across attempts and completed normally after lifecycle recovery.
- [x] Exact live model label: `GPT-5.6 Sol`.
- [x] `instant`, `medium`, and `high` selectable and verified.
- [x] `extra-high` unavailable on the current account/profile and correctly fail-closed before task submission.
- [x] Parallel `medium` and `high` workers simultaneously durable/browser `running` and `verified=true` after the picker-race fix.
- [x] Target-loss recovery preserved durable `GPT-5.6 Sol / high / fail-closed` intent, advanced browser attempt 1->2, changed browser handle, and recorded a fresh verified observation.
- [x] Deliberately unavailable model `__c2c_nonexistent_model__` failed before task submission with bounded diagnostics.
- [x] Mapped ChatGPT Project routing verified.
- [x] Worker `/mcp/worker` catalog/capability isolation and normal main `/mcp` behavior verified.
- [x] Final cross-platform CI green: run `35172617811` on `5dac24f96bd9ae162ad26a0b29bfeb96883526bd`.

## M7 - Worker Placement Policy — complete

Design/live evidence: `docs/M7-WORKER-PLACEMENT.md`.

- [x] Windows EXE settings expose `Worker ChatGPT Project URL`.
- [x] A configured fixed URL forces every new Worker into that ChatGPT Project.
- [x] Fixed EXE placement outranks an explicit per-worker `standalone` request.
- [x] With the EXE URL blank, `agent_spawn` can request either `standalone` or a specific ChatGPT Project URL per worker.
- [x] With no per-worker request, the existing local-project -> ChatGPT-Project mapping remains available, with standalone fallback.
- [x] Placement is persisted durably per Worker once resolved so later mutable settings do not silently move an existing Worker.
- [x] Existing `agent_project_route_set` deferred-routing behavior remains compatible.
- [x] Invalid/non-ChatGPT fixed URLs fail before browser submission.
- [x] Final cross-platform CI green: run `35175254790` on `1eaf8fa75c24bf814b37090e5f0b4a02bfabb7bd`.
- [x] Live Windows validation confirmed fixed placement, fixed-over-standalone precedence, blank+standalone, and blank+specific-project placement.

## Current queue

- [ ] Select the next roadmap unit before implementation; M7 core placement behavior is complete.
- [ ] Naturally cross the original 30-minute local-control TTL during normal use and confirm no `LEASE_REQUIRED` regression; this remains non-blocking.
- [ ] Keep Worker MCP/app/control isolation green while future work evolves.

## Update policy

Update this file whenever a milestone/unit is completed, blocked, materially redesigned, or moved in scope. Keep `docs/SESSION-HANDOFF.md` and relevant design/live-validation documents synchronized with the current milestone state.