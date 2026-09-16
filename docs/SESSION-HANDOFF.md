# Session Handoff

Operational handoff for continuing `chatgpt2codex` across ChatGPT sessions. Read this before making changes, then verify it against the live repository and latest CI. If this file and the repository disagree, the repository is authoritative and this file must be corrected as part of the work.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: stable ChatGPT-Web-driven coding runtime without depending on local Codex quota while preserving the original Core authorization/project/file/shell/git path.

The original M0-M5 roadmap is complete. Do not invent an M6 automatically; continue stabilization/integration work first.

## How to work with the user

The user prefers implementation-first progress.

- When the user says `진행해`, `이어가자`, `해줘`, or otherwise authorizes the next unit, inspect current repo/CI and do the repo work in the same turn.
- Do not repeatedly ask permission for already-authorized work.
- Work one coherent unit at a time.
- Per unit: **implement -> focused tests/CI -> fix failures -> update progress/handoff docs**.
- Prefer concrete state/change/commit/CI reports over speculative explanation.
- Windows/VMware is the active live-validation target; preserve Ubuntu/macOS CI.
- If a live step must be performed by the user, give exact ready-to-run/setup steps and the expected result.

## Persistent engineering boundaries

- Core stability is more important than optional extensions.
- Reuse existing authorization / lease / capability / durable-state boundaries; do not create parallel authority systems.
- Durable worker state is the source of truth for worker lifecycle/results.
- Full-write workers use isolated Git branches/worktrees and scoped worker capabilities.
- Browser-worker repository authority is derived only from `WORKER_CORE_TOOL_NAMES` plus `worker_finish`.
- Windows Computer Use reuses the existing control lease/policy/audit plane.
- Hooks are best-effort observational extensions, not authorization.
- Agent Skills use bounded discovery/install/activation/security paths; **skill scripts never automatically execute**.
- External MCP plugins remain main-agent extensions behind fixed Core proxies; browser workers do not inherit plugin access.
- Pointer/halo/ripple Computer Use experiments were removed. Keep the subtle edge glow unless the user explicitly reopens it.

## Ponytail

`src/agents/ponytail.ts` is an instruction-layer coding policy, not an authorization mechanism.

- default: `full`
- task-local: `ponytail lite|full|ultra/off` or slash variants
- durable worker task remains unchanged; adaptation is applied only to browser-worker instructions
- prefer reuse/native/direct solutions and minimal coherent diffs without weakening validation/security/error handling/accessibility/data integrity.

## Completed stabilization evidence

### External MCP / Skills

1. Core plugin lifecycle: `plugin_register -> enable -> discover -> plugin_call -> disable -> denied call -> remove`.
   - commit `5fbc010b`
   - CI `35011189776` green on Ubuntu/macOS/Windows.
2. Plugin `skillSources` declaration through normal external Git Skill lifecycle.
   - commit `c99bee63`
   - CI `35013285118` green.
   - declaration remains inert and fixture scripts remain unexecuted.
3. Plugin configuration vs worker capability registration.
   - no `worker_plugin_*`
   - worker mirrors remain exactly derived from `WORKER_CORE_TOOL_NAMES`
   - dispatcher rejects plugin tools before worker capability use
   - commit `f849dff0`
   - CI `35014499804` green.

### Hard worker MCP server isolation

The shared remote catalog gap is closed server-side.

```text
main ChatGPT app
  -> /mcp
  -> normal main-agent Core catalog (including configured plugin proxies)

worker ChatGPT app
  -> /mcp/worker
  -> worker_finish + worker_* mirrors only
  -> scoped workerToken
  -> isolated worktree
```

Properties regression-tested:

- dedicated worker-only `McpServer` factory;
- worker catalog excludes unprefixed plugin/main tools, Skills, Agent Manager, Computer Use, and ordinary file/shell/git tools;
- `/mcp` retains main-agent plugin proxies;
- OAuth audiences are exact-matched between `/mcp` and `/mcp/worker`;
- MCP sessions are role-bound (`main|worker`);
- cross-route token/session replay is rejected;
- existing opaque `workerToken` remains the per-worker repository authority.

Implementation/test HEAD for this boundary: `87f497f0`.
CI `35017393064`: Ubuntu/macOS/Windows all green.

### ChatGPT message-level worker app routing

The Chrome/CDP browser-worker driver explicitly selects the worker custom app before submitting the task message.

Current behavior in `src/agents/chrome-cdp.ts`:

1. open mapped ChatGPT Project or standalone ChatGPT;
2. wait for the composer;
3. type `@ChatGPT To Codex Worker`;
4. select the matching app from ChatGPT's app picker;
5. verify the selected inline app entity;
6. append worker bootstrap + scoped capability;
7. submit.

Important properties:

- Default worker app display name: `ChatGPT To Codex Worker`.
- Override exact installed name with `CHATGPT2CODEX_WORKER_APP_NAME`.
- If the worker app is missing, launch fails closed before task submission; it never silently falls back to the main `/mcp` app.
- Initial launch and recovery use the same browser driver/routing rule.
- App selection does not grant repository authority; `workerToken` is still required on every worker call.
- Main-agent app remains independent on `/mcp`.

Initial routing implementation/test commits:

- `236994e7` - browser-worker worker-app selection/routing
- `8b0b8b07` - message-routing tests
- `1a50605f` - corrected test fake
- CI `35022343381` green on Ubuntu/macOS/Windows.

### Live ChatGPT worker-app stabilization and validation

Real VMware/ChatGPT validation exposed several UI details that deterministic tests had not modeled:

- ChatGPT app rows include a subtitle, so candidate matching cannot require whole-row exact text.
  - `415b8e3` / `5c886bb`
- ChatGPT can show an app as selected while the old detection logic reports failure.
  - `8ccb755` / `1022fc1` / `c956c3d`
- A real DOM diagnostic showed the selected app is represented **inside `#prompt-textarea` as an inline `<a>` element**, not only as an external chip.
  - diagnostic helper: `904ab967`
  - actual fix: `6179841e`
  - regression test: `f081c065`
  - CI `35045017337` green on Ubuntu/macOS/Windows, including Windows native input/UIA/activity-indicator/build/launcher jobs.

Real live setup/validation completed successfully:

- Main app remains `ChatGPT To Codex -> <public-origin>/mcp`.
- Worker app is `ChatGPT To Codex Worker -> <public-origin>/mcp/worker` and completed OAuth.
- Worker app is visible in the dedicated worker Chrome profile's `@` picker.
- Manual tool-list sanity check showed the expected worker-only catalog.
- `c2c-smoke` was initialized with a first Git commit so an isolated worktree could be created.
- Dedicated worker Chrome profile was logged into ChatGPT once and then reused.
- The same pending durable worker `wrk_3fb5f6f7-43a7-47e5-9da1-5db1a90b086b` was retried after UI-routing fixes rather than replaced.
- Final live run automatically selected the worker app, read the README, reported the first heading as `# c2c-smoke`, made no file changes, and completed through `worker_finish`.

This closes the primary real connected-worker-app evidence gap. Do **not** claim that a separate live `running -> lost target -> recoverRunningBrowserWorker` recovery scenario has been tested; only same-pending-worker relaunch/retry was exercised live. Recovery still shares the same driver in code/CI.

Setup/runbooks:

- `docs/CHATGPT-WORKER-APP-SETUP.md`
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md`

## Active unit

**Post-live-smoke stabilization cleanup.**

The primary browser-worker custom-app path is now proven in the real user environment. Before defining any new milestone, handle only concrete stabilization follow-ups discovered by live use.

Known follow-up observations:

1. A separate live running-worker recovery smoke (`running` worker with lost/stopped browser target -> recovery) has not yet been exercised end-to-end, although initial launch/retry and recovery use the same driver path in code.
2. During some manual tests, the parent MCP lease was temporarily raised to `full-write`; a remote session could not restore `control` because `control` re-grant is intentionally local-authority-only. Treat this as a UX/operational follow-up, not as permission to weaken the authorization boundary.
3. Keep CI green and fix only integration defects before considering broader scope.

## Remaining stabilization work

In order unless a real defect changes priority:

1. **Completed:** external MCP full lifecycle smoke (`5fbc010b`, CI `35011189776`).
2. **Completed:** plugin skill-source -> normal Skill lifecycle (`c99bee63`, CI `35013285118`).
3. **Completed:** plugin vs worker capability registration (`f849dff0`, CI `35014499804`).
4. **Completed:** hard worker MCP server/catalog/OAuth boundary (`87f497f0`, CI `35017393064`).
5. **Completed:** browser driver selects the dedicated worker app per task message (`236994e7` onward).
6. **Completed live:** real `ChatGPT To Codex Worker` connection and representative pending-worker launch/retry through `worker_finish`; final DOM-routing fix `6179841e`, regression `f081c065`, CI `35045017337`.
7. **Optional live follow-up:** running-worker recovery smoke through the same worker app.
8. Review the lease-restoration UX exposed during manual testing without weakening local-only `control` authority.
9. Keep CI green and fix integration defects before defining any new milestone.

## Source-of-truth documents

- `docs/CUSTOM-RUNTIME-PROGRESS.md` - milestone/unit status and validation history.
- `docs/CUSTOM-RUNTIME-PLAN.md` - architecture and roadmap.
- `docs/CHATGPT-WORKER-APP-SETUP.md` - current two-app configuration and live smoke.
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md` - Project placement vs message-level worker-app routing.
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
6. If they match, continue the active stabilization unit immediately.

A future user message consisting only of **`SESSION-HANDOFF.md 읽고 이어서 진행해`** should be enough to resume.
