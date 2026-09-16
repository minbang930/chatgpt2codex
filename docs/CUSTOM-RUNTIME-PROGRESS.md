# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M6 - Worker Execution Configuration**

Active unit: **M6.3 - ChatGPT Web model/reasoning set-and-verify adapter**

Primary operational handoff: `docs/SESSION-HANDOFF.md`.

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

## M6 - Worker Execution Configuration

Design/source of truth: `docs/WORKER-EXECUTION-CONFIG-DESIGN.md`.

### M6.1 - Execution settings foundation — complete

- [x] Added normalized `WorkerExecutionPreference` / `WorkerExecutionIntent` contracts.
- [x] Initial reasoning keys are `instant | medium | high | extra-high`; model remains a normalized string target owned by the future browser adapter.
- [x] Added `fallbackPolicy = fail-closed | allow-current` with automatic `fail-closed` when model/reasoning resolves explicitly without a configured policy.
- [x] Added deterministic per-field precedence `worker > project > global` with source metadata.
- [x] Added versioned atomic persistence at `<stateDir>/agents/worker-execution-settings.json` for one global default and optional project overrides.
- [x] Missing settings state preserves the legacy unmanaged/current-ChatGPT behavior.
- [x] Added main-agent-only `worker_execution_settings_get`, `worker_execution_settings_set`, and `worker_execution_settings_clear`.
- [x] Global/project mutations reuse the existing `worker` capability; no new authorization primitive was added.
- [x] The new settings tools are not registered on `/mcp/worker`.
- [x] Existing browser launch/bootstrap code remained unchanged in M6.1.

Implementation sequence: `f3a763f0`, `418495d1`, `19a4ff65`, `451dab05`, `ff568723`, `fdc9c6af`.
Full CI `35125045144` on code HEAD `fdc9c6af07821870dfd2ca02b83563ea696be590`: **green on macOS, Ubuntu, and Windows**.

### M6.2 - Durable per-worker intent — complete

- [x] `agent_spawn` accepts an optional normalized `execution` override without changing existing callers.
- [x] Global/project/per-worker execution preferences are resolved **before** durable worker creation.
- [x] The resolved/requested/source metadata is persisted as optional `WorkerRecord.executionIntent` before browser launch.
- [x] Older worker JSON and workers created with no execution settings remain readable and retain no `executionIntent` field.
- [x] Resolution remains per field, so worker/project/global values can compose deterministically.
- [x] Later global/project default changes do not mutate an already-created worker's execution intent.
- [x] Initial launch and running-worker recovery reuse the same durable worker record and do not re-resolve mutable defaults.
- [x] Lifecycle regression proves an intent survives default changes, initial browser launch, target failure, and same-worker recovery unchanged.
- [x] MCP regression proves a per-worker `agent_spawn.execution` override wins over project/global defaults and is durable before launch.
- [x] M6.2 does not yet automate or verify the ChatGPT model/reasoning UI; that begins in M6.3.

Implementation/test sequence: `b234c58f`, `ff13722c`, `9e5de414`, `da5a10ca`, `c3017969`, `ecb1f076`.

Full CI `35129481274` on code HEAD `ecb1f0764f6fd4080012e202304ea09c4d2a2a7a`: **green on macOS, Ubuntu, and Windows**, including typecheck, new durable-intent/agent tests, existing agent/skills/plugins/hooks tests, Windows native input/UIA/activity-indicator/hostname/startup-context tests, build, and Windows launcher build.

M6.2 exit criterion is satisfied: every explicitly configured new worker has stable durable execution intent before browser launch, and recovery cannot silently re-resolve changed defaults.

### M6.3 - ChatGPT Web model/reasoning set-and-verify adapter — active

- [ ] Inspect the current live ChatGPT model/reasoning UI in the dedicated worker profile before finalizing selector/label mapping.
- [ ] Add a narrow browser execution-settings adapter for bounded observation and application.
- [ ] Consume `WorkerRecord.executionIntent` on both initial launch and recovery.
- [ ] Verify observed state after any UI interaction; a click alone is not success.
- [ ] Default explicit requests to fail closed when unsupported or unverifiable.
- [ ] Ensure no worker bootstrap can be submitted while explicit execution intent remains unverified.
- [ ] Add fake-CDP regressions for unsupported values, false-positive clicks, stale/ambiguous UI state, and verification failure.

## Current queue

- [ ] Implement M6.3 only, taking the actual current dedicated-worker ChatGPT UI as evidence before freezing selectors/labels.
- [ ] Naturally cross the original 30-minute local-control TTL during normal use and confirm no `LEASE_REQUIRED` regression; this remains non-blocking.
- [ ] Keep Worker MCP/app/control isolation green while M6 evolves.

## Update policy

Update this file whenever an M6 unit is completed, blocked, materially redesigned, or moved in scope. Keep `docs/SESSION-HANDOFF.md` and `docs/WORKER-EXECUTION-CONFIG-DESIGN.md` synchronized with the active M6 unit.
