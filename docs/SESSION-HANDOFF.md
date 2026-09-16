# Session Handoff

Operational handoff for continuing `chatgpt2codex` across ChatGPT sessions. Verify this file against the live repository and current CI before making changes; the repository is authoritative when they disagree.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: stable ChatGPT-Web-driven coding runtime without depending on local Codex quota while preserving Core authorization/project/file/shell/git boundaries.
- The original M0-M5 roadmap is complete. Do not invent an M6 automatically; continue stabilization/integration work first.

## How to work with the user

The user prefers implementation-first progress. When the user says `진행해`, `이어가자`, `해줘`, or otherwise authorizes the next unit, inspect the current repo/CI and do the work in the same turn. Work one coherent unit at a time: implement -> focused tests/CI -> fix failures -> update progress/handoff docs. Windows/VMware is the active live-validation target while Ubuntu/macOS CI must stay healthy.

## Persistent engineering boundaries

- Durable worker state is the source of truth for worker lifecycle/results.
- Full-write workers use isolated Git branches/worktrees and scoped opaque worker capabilities.
- Browser-worker repository authority is derived only from `WORKER_CORE_TOOL_NAMES` plus `worker_finish`.
- `/mcp/worker` exposes the worker-only catalog and has a distinct exact OAuth resource audience from `/mcp`.
- The dedicated `ChatGPT To Codex Worker` custom app must be selected fail-closed; never silently fall back to the main app.
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
- task-local: `ponytail lite|full|ultra/off` or slash variants
- durable worker task remains unchanged; adaptation is applied only to browser-worker instructions
- never simplify away validation/security/error handling/accessibility/data integrity/user requirements.

## Completed stabilization evidence

### External MCP / Skills

- Core plugin lifecycle live-smoked: `5fbc010b`, CI `35011189776` green.
- Plugin `skillSources` through the normal Git Skill lifecycle: `c99bee63`, CI `35013285118` green.
- Plugin configuration does not expand worker capability registration: `f849dff0`, CI `35014499804` green.

### Hard worker MCP isolation

Main and worker transports are separate:

```text
main ChatGPT app   -> /mcp        -> normal main-agent Core catalog
worker ChatGPT app -> /mcp/worker -> worker_finish + worker_* mirrors only
```

The worker catalog excludes unprefixed plugins, Skills, Agent Manager, Computer Use, and ordinary file/shell/git tools. OAuth resource audiences are exact-matched, sessions are role-bound, and cross-route token/session replay is rejected. The opaque `workerToken` remains per-worker repository authority. Implementation/test HEAD for this boundary: `87f497f0`; CI `35017393064` green.

### Browser Worker app routing

Current `src/agents/chrome-cdp.ts` behavior:

1. open mapped ChatGPT Project or standalone ChatGPT;
2. wait for composer;
3. preserve a genuine selected Worker-app inline entity, otherwise clear only an exact stale plain-text `@ChatGPT To Codex Worker` draft;
4. type/select `@ChatGPT To Codex Worker` from the current role-less app picker;
5. after a picker click, explicitly verify the selected inline app entity before clearing the exact query or treating selection as successful;
6. append worker bootstrap + scoped capability and submit only after selected-entity verification.

Important stabilization commits include initial routing `236994e7`, subtitle-aware matching `415b8e3`/`5c886bb`, selected-state fixes `8ccb755`/`1022fc1`/`c956c3d`, actual inline selected-app detection `6179841e` + `f081c065`, role-less picker support `95375f7` + `2f00ae9` + `878aa3d`, exact stale-draft handling `5b16988d` + `62844fa6`, and post-picker selected-entity verification `7c3bf2c4` with regressions `ae3b5b8b`/`9d036fcf`/`02ab05c3`. CI `35095515554` is green on macOS, Ubuntu, and Windows.

A picker-row click is not authoritative by itself: a false-positive click that does not materialize the Worker-app selected entity now keeps polling and then fails closed without submitting the worker bootstrap. The exact typed Worker-app query is only cleared after verified selection.

Do not overstate the live stale-draft evidence: the runtime has been updated with the automatic stale-draft fix and code/CI coverage is green, while the earlier stale condition in the live profile was manually cleared before the clean initial-selection smoke.

### Connected Worker-app live validation

- Main app: `ChatGPT To Codex -> <public-origin>/mcp`.
- Worker app: `ChatGPT To Codex Worker -> <public-origin>/mcp/worker`.
- Dedicated worker Chrome profile is logged in once and reused.
- Fresh initial-selection worker `wrk_777c1c14-8f66-462a-a95c-774db8f05c6b` completed `agent_launch -> running -> worker_finish -> agent_wait -> agent_result`, confirmed README heading `# c2c-smoke`, and made no project changes.

### Control-preserving worker orchestration

Worker orchestration is distinct from direct parent write authority:

```text
control    = read + control + worker
full-write = read + verify + write + image + remote + worker
```

`control` still does not grant direct project write/verify/image/remote. `full-write` still does not grant desktop control. `agent_spawn`, `agent_launch`, and worker Project route mutations require the dedicated `worker` capability. Worker edits remain behind the worker's opaque capability in its isolated worktree.

Implementation: `9fd2a6b`, `6d7ce6f`, `6fe7f5c`, `f32ad00`, `de6926d`; regression coverage `b303e47`, `2f9ad59`, `2537462`; CI `35053101356` green. Live VMware validation kept the parent on `control` for `agent_spawn -> agent_launch -> agent_wait -> agent_result`; README `# c2c-smoke`, no file changes, no `full-write` reselection.

### True running-worker browser recovery — live proven

Live worker: `wrk_7270a415-1519-4f9e-905c-5d221c63266a`.

Observed sequence:

```text
browser attempt 1 / durable running
-> Worker browser tab manually closed
-> agent_status reconciliation
   durable=running, browser=failed, recoverable=true
-> same workerId agent_launch
   recovered=true, browser attempt=2
-> worker completed normally through worker_finish
-> durable=completed, browser=stopped, completionFallback=false
-> agent_result: README heading # c2c-smoke, remainingIssues=[]
```

The smoke task created `.recovery-smoke-marker` on its first run and deleted it on recovery. `changedFiles: [".recovery-smoke-marker"]` in the final worker result is worker-reported touched-file metadata, not proof of a remaining dirty file. The worker explicitly reported marker deletion and no commit/push.

### Persistent rolling local control authorization

The 30-minute control lease UX is now hidden after the owner has locally armed control once for the project.

Design:

- `sessions.json` persists a separate `controlLease` lane representing local Computer Use authorization.
- A locally created active `control` lease is automatically promoted into `controlLease`.
- Older sessions that only contain an active control lease are migrated in memory into the durable control lane, so upgrading does not force an immediate re-arm.
- Changing the normal project preset, including to `full-write`, preserves the local control authorization instead of silently revoking it.
- `requireProjectLease()` tries the normal active lease first, then the durable control lane for only the capabilities that `control` legitimately grants (`read`, `control`, `worker`).
- An expired durable control lease is transparently rolled to a fresh lease window and persisted with ledger event `control.lease.renewed`.
- `write`, `verify`, `image`, and `remote` are never obtained from the durable control lane.
- Explicit empty-session reset clears the durable local grant.
- Remote `/mcp` still cannot grant `preset=control` because the existing remote guard remains unchanged.
- Lease renewal never clears the Computer Use kill switch.

Implementation sequence: `04b4809`, `7e2e5fc`, `34d6968`, `e927e2b`, `58bb0aa`, `fa31065`, `8222d74`, `0aa28b3`, final type-narrowing fix `8fab58a`.

CI `35090954861` for code HEAD `8fab58afd2828d11d8898697bc828dda4ed694da` passed on macOS, Ubuntu, and Windows, including Windows agent, native input, UIA, activity indicator, build, and launcher jobs.

Live VMware coexistence smoke after pull/build/restart also passed: the user selected `c2c-smoke` as `full-write`, then captured a Notepad screenshot using the previously granted local control authorization without calling `project_select preset=control` again. This proves the local control lane survives an ordinary active-preset change. The exact 30-minute wall-clock expiry/renewal path is covered in code/CI but has not yet been separately waited out and observed live.

Security meaning: users no longer need to care about the short lease expiry during ordinary use, but ChatGPT still cannot self-elevate into control. Local arming remains the root authorization event, and the kill switch remains authoritative.

### Terminal Worker browser recovery status UX

`agent_status` no longer reports a terminal durable worker as recoverable merely because its browser session is `stopped` or `failed`.

`browser.recoverable` is now true only when both conditions hold:

```text
durable worker status = running
AND
browser status = failed | stopped
```

A durable `completed`, `failed`, or `cancelled` worker therefore reports `recoverable=false`. The actual running-worker recovery behavior remains unchanged.

Implementation: `63e22692` (`fix: report browser recovery only for running workers`); regression coverage: `3c745d3d` (`test: hide recovery after durable completion`). CI `35093400146` passed on macOS, Ubuntu, and Windows.

### Post-picker Worker-app verification

`selectWorkerApp()` now requires observable selected-app state after a picker click before it can clear the typed query or return success. A click result of `{ ok: true }` is only an interaction signal, not proof of selected identity.

Implementation: `7c3bf2c4`. Regression coverage: `ae3b5b8b`, `9d036fcf`, `02ab05c3`. CI `35095515554` passed on macOS, Ubuntu, and Windows, including Windows Agent/native input/UIA/activity indicator/build/launcher jobs.

This preserves the existing selected-chip/inline-anchor, role-less picker, subtitle row, and stale-draft paths while closing the false-positive click path.

### Direct Windows launcher / named-tunnel reuse — live proven

Direct `start-chatgpt.ps1` launch now reuses the native launcher's saved hostname instead of requiring the user to manually supply `PUBLIC_HOSTNAME` each time. It also handles the startup project/workspace relationship and surfaces early server-start failures directly.

Behavior:

- explicit `-PublicHostname` / persistent environment values still take precedence;
- when web/named-tunnel use is already requested, the script can read the current launcher's Base64 `PublicHostname` from `%LOCALAPPDATA%\ChatGPT To Codex\settings.ini`, with the legacy roaming JSON as fallback;
- saved hostname alone does not silently enable web exposure;
- when `-Workspace` is omitted but `-ActiveProjectRoot` is provided, the active project itself becomes the workspace, so startup selection can actually find it;
- if the local server exits before `/healthz` becomes ready, the launcher reports the process exit and stderr tail rather than only a generic health timeout.

Implementation sequence for hostname reuse: `04b18cde`, `9d141c4f`, `8679301f`, `0aa70eab`, `946dcc8f`. Startup-context/diagnostic follow-up: `1a661d77`, `4ff97762`, `f52cad27`, cleanup `c4672019`.

CI `35111157222` on `c4672019d2ddb482924b341de1969f6613aeb922` is green on macOS, Ubuntu, and Windows, including the Windows hostname resolver and startup-context tests plus Agent/native input/UIA/activity indicator/build/launcher jobs.

Live VMware validation is complete. The user ran the previously failing command with only `-ActiveProjectRoot "C:\Dev\c2c-smoke" -ActiveProjectPreset control`, observed saved-hostname reuse, then after the startup-context fix reran it and reached `ChatGPT To Codex is ready` without manually supplying `-PublicHostname`.

## Active unit

**Post-live-smoke stabilization cleanup.** The primary Worker-app path, control-preserving worker orchestration, true browser-target recovery, rolling local control authorization, terminal recovery-status semantics, post-picker selected-entity verification, and direct Windows launcher/named-tunnel reuse are implemented and code/CI validated. Browser recovery, control/full-write coexistence, and direct launcher reuse are also proven in the live VMware environment.

Remaining integration cleanup, in practical priority order:

1. Let ordinary live use naturally cross the original 30-minute control TTL and confirm no `LEASE_REQUIRED` regression; code/CI already covers renewal, so no forced wait is required.
2. Keep CI green and fix integration defects before defining any new milestone.

## Runtime/update note

`start-chatgpt.ps1` builds only when `dist/cli.js` is missing, not whenever `src` is newer. After pulling source changes that touch TypeScript runtime code on the VM, run `npm run build` before restarting. PowerShell-only launcher changes do not require a TypeScript rebuild. A direct project-specific local arm can now use `start-chatgpt.ps1 -ActiveProjectRoot <project> -ActiveProjectPreset control` without separately supplying the already-saved public hostname.

## Source-of-truth documents

- `docs/CUSTOM-RUNTIME-PROGRESS.md` - milestone/unit status and validation history.
- `docs/CUSTOM-RUNTIME-PLAN.md` - architecture and roadmap.
- `docs/CHATGPT-WORKER-APP-SETUP.md` - two-app configuration.
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md` - Project placement vs message-level Worker-app routing.
- `docs/PLUGINS-DESIGN.md` - external MCP plugin boundary.
- `docs/SKILLS-DESIGN.md` - Agent Skills lifecycle/security.
- `docs/HOOKS-DESIGN.md` - Hooks semantics.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` - Windows Computer Use boundary.

## New-session start procedure

1. Read this file.
2. Read current/planned sections in `docs/CUSTOM-RUNTIME-PROGRESS.md`.
3. Check actual `dev/custom-runtime` HEAD.
4. Check latest CI for that HEAD.
5. If docs and repo disagree, trust repo and update docs.
6. Continue the active stabilization unit immediately.

A future user message consisting only of `SESSION-HANDOFF.md 읽고 이어서 진행해` should be enough to resume.
