# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **Implementation roadmap complete through M5**

Active unit: **Post-M5 stabilization / integration cleanup**

Primary operational handoff: `docs/SESSION-HANDOFF.md`.

Detailed design documents:

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

Relevant commits: `415b8e3`, `5c886bb`, `6179841e`, `f081c065`, `95375f7`, `2f00ae9`, `878aa3d`, `5b16988d`, `62844fa6`.

Stale-draft regression CI `35051793885` green. Live clean initial Worker-app selection was proven after manually clearing the earlier stale diagnostic draft; do not claim that the automatic stale-draft branch itself was separately live-smoked.

### Connected Worker-app initial completion path

- [x] Dedicated Worker app completed OAuth and exposes only the worker catalog.
- [x] Fresh initial-selection worker `wrk_777c1c14-8f66-462a-a95c-774db8f05c6b` transitioned to `running` through the Worker app.
- [x] Same worker confirmed README heading `# c2c-smoke`, made no file changes, called `worker_finish`, produced an `agent_wait` completion event, and returned the durable result through `agent_result`.

### Control-preserving Worker orchestration

- [x] Added dedicated `worker` lease capability.
- [x] `control = read + control + worker`.
- [x] `full-write = read + verify + write + image + remote + worker`.
- [x] `control` still denies parent direct write/verify/image/remote.
- [x] `full-write` still denies desktop control.
- [x] `agent_spawn`, `agent_launch`, and Worker Project route mutations require `worker` instead of generic `write`.
- [x] Worker edits remain scoped to opaque `workerToken` + isolated worktree.

Implementation: `9fd2a6b`, `6d7ce6f`, `6fe7f5c`, `f32ad00`, `de6926d`; tests `b303e47`, `2f9ad59`, `2537462`.
CI `35053101356` green across Ubuntu/macOS/Windows including Windows helper/build jobs.

- [x] Live VMware smoke kept the parent on `control` for `agent_spawn -> agent_launch -> agent_wait -> agent_result` without switching to `full-write`; README `# c2c-smoke`, no project changes.

### True running-worker browser recovery — live complete

- [x] Spawned/launched recovery worker `wrk_7270a415-1519-4f9e-905c-5d221c63266a` and left durable state `running`.
- [x] Manually closed only its Worker browser tab.
- [x] `agent_status` reconciled durable `running` + browser `failed`, `recoverable=true`, attempt `1`.
- [x] Re-launched the same workerId; response reported `recovered=true`, browser attempt `2`.
- [x] Worker reached durable `completed` without completion fallback; browser became `stopped`.
- [x] Final `agent_result` confirmed README heading `# c2c-smoke`, marker cleanup, no commit/push, and no remaining issues.

This live smoke proves the actual `running -> target loss -> reconcile -> same-worker recovery -> completed` path rather than only the initial launch/retry path.

### Rolling local control authorization — code/CI and live coexistence complete

Goal: the user should not need to notice or manually refresh the short control lease TTL during ordinary use after locally authorizing Computer Use once.

- [x] Added reusable rolling lease-window helper in `src/workspace/project-select.ts` while leaving generic `requireLease()` expiry semantics intact.
- [x] Added durable `controlLease` to `sessions.json` as a separate local-control authorization lane.
- [x] A locally granted active control lease is promoted into the durable control lane automatically.
- [x] Older sessions containing only an active control lease are migrated in memory so upgrades do not immediately require a new local arm.
- [x] Normal project preset changes preserve the durable control authorization, including switching the active project lease to `full-write`.
- [x] `requireProjectLease()` uses the normal active lease first, then falls back to durable local control only for `read`, `control`, and `worker`.
- [x] Expired durable control authorization transparently renews and emits `control.lease.renewed`.
- [x] The durable control lane never grants `write`, `verify`, `image`, or `remote`.
- [x] Explicit empty-session reset clears the durable local grant.
- [x] Remote `/mcp` still cannot mint `preset=control`; the existing remote guard remains intact.
- [x] Renewal never clears the desktop-control kill switch; a fresh local grant is still required after a kill.
- [x] Added tests for renewal, backward migration, preservation across preset changes, active `full-write` + durable `control` coexistence, and non-control expiry remaining `LEASE_REQUIRED`.
- [x] Live VMware after pull/build/restart: selected `c2c-smoke` as `full-write`, then captured a Notepad screenshot using the existing local control grant without a new `project_select preset=control` call.

Implementation/test sequence: `04b4809`, `7e2e5fc`, `34d6968`, `e927e2b`, `58bb0aa`, `fa31065`, `8222d74`, `0aa28b3`, final narrowing fix `8fab58a`.

Code CI `35090954861` on `8fab58afd2828d11d8898697bc828dda4ed694da`: **green on macOS, Ubuntu, and Windows**, including Windows Agent tests, native input helper, UIA helper, activity indicator helper, build, and launcher build.

The live coexistence smoke proves that normal preset changes do not revoke local control authorization. The exact 30-minute wall-clock expiry/renewal path remains code/CI-proven but has not been separately waited out and observed live; it can be verified naturally during ordinary use.

### Terminal Worker recovery-status UX — complete

- [x] `browser.recoverable` now requires durable worker status `running` in addition to browser state `failed` or `stopped`.
- [x] Durable `completed`, `failed`, and `cancelled` workers therefore no longer advertise recovery merely because the browser session is terminal.
- [x] Existing running-worker target-loss semantics remain unchanged (`running` + `failed/stopped` => recoverable).
- [x] Added regression coverage for a durable completed worker with browser `stopped` returning `recoverable=false`.

Implementation: `63e22692`; test: `3c745d3d`.
CI `35093400146`: **green on macOS, Ubuntu, and Windows**.

### Post-picker Worker-app selected-entity verification — complete

- [x] A successful picker-row click is no longer treated as proof that the Worker app was selected.
- [x] After a click reports success, `selectWorkerApp()` explicitly re-runs selected-entity detection before clearing the exact typed query or returning success.
- [x] If the click does not materialize the selected Worker-app entity, the flow keeps polling and ultimately fails closed rather than submitting the bootstrap under an unverified app state.
- [x] The exact typed `@ChatGPT To Codex Worker` query is not cleared after a false-positive click.
- [x] Regression coverage includes click-success-without-selected-entity failure, role-less picker selection, subtitle-bearing app rows, existing selected-app recovery, and stale-draft behavior.

Implementation: `7c3bf2c4`; tests: `ae3b5b8b`, `9d036fcf`, `02ab05c3`.
CI `35095515554`: **green on macOS, Ubuntu, and Windows**, including Windows Agent/native input/UIA/activity indicator/build/launcher jobs.

### Direct Windows named-tunnel hostname reuse — code/CI complete

- [x] `start-chatgpt.ps1` now understands both persistent `PUBLIC_HOSTNAME` and `CHATGPT2CODEX_PUBLIC_HOSTNAME`, not only the inherited process environment.
- [x] When web exposure/named-tunnel use is already requested and no explicit/environment hostname exists, the script reuses the hostname saved by the current native launcher in `%LOCALAPPDATA%\ChatGPT To Codex\settings.ini`.
- [x] Legacy `%APPDATA%\ChatGPT To Codex\settings.json` `PublicHostname` remains a fallback for older tray setups.
- [x] Saved UI settings do not enable public exposure by themselves; they are consulted only after `-ExposeWeb`, `CHATGPT2CODEX_EXPOSE_WEB=1`, or named-tunnel credentials/name already request a tunnel.
- [x] Host values are normalized from full URLs to hostnames before tunnel/public-URL construction.
- [x] The script never copies or persists Cloudflare tunnel tokens; existing token/name lookup and security boundaries remain unchanged.
- [x] Added Windows CI coverage for explicit/env precedence, current launcher Base64 settings format, legacy fallback, direct-script wiring, and PowerShell parse validity.

Implementation sequence: `04b18cde`, `9d141c4f`, `8679301f`, parser/test fixes `0aa70eab`, `946dcc8f`.
CI `35102639492` on `946dcc8f5acd12fa813a8890ad06987774b64159`: **green on macOS, Ubuntu, and Windows**, including the new Windows public-hostname resolver test plus Windows Agent/native input/UIA/activity indicator/build/launcher jobs.

Live direct-script validation on the user's VMware runtime is still pending. The intended smoke is the previously failing `start-chatgpt.ps1 -ActiveProjectRoot ... -ActiveProjectPreset control` path without manually supplying `-PublicHostname`.

## Current stabilization queue

- [ ] Live-smoke direct `start-chatgpt.ps1` named-tunnel hostname reuse on VMware without manually supplying `-PublicHostname`.
- [ ] Naturally cross the original 30-minute local-control TTL during normal use and confirm no `LEASE_REQUIRED` regression. Code/CI already covers renewal; no forced wait is required.
- [ ] Keep CI green and fix integration defects before defining any new milestone.

## Update policy

Update this file whenever a unit is completed, blocked, materially redesigned, or moved in scope. Keep `docs/SESSION-HANDOFF.md` synchronized when a stabilization unit completes or major live validation changes the next session's context.
