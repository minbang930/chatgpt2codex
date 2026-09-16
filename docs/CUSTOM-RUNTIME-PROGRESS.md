# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **Implementation roadmap complete through M5**

Active unit: **Post-M5 stabilization / post-live-smoke cleanup**

Detailed design documents:

- `docs/SESSION-HANDOFF.md` - current operational context for continuing work across ChatGPT sessions.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md`
- `docs/HOOKS-DESIGN.md`
- `docs/SKILLS-DESIGN.md`
- `docs/PLUGINS-DESIGN.md`
- `docs/CHATGPT-WORKER-APP-SETUP.md` - dedicated worker custom-app setup and live-smoke procedure.

## Completed

### M0 - Baseline

- [x] Fork and `dev/custom-runtime` branch created.
- [x] Baseline preserved against upstream starting point.
- [x] Cross-platform CI established for typecheck/tests/build; Windows launcher/native-helper regressions are covered separately.

Key commits: `bac50959`, `53c2d1a4`.

### M1 - Local multi-agent runtime

#### M1.1 - Durable worker state and inbox

- [x] Durable `pending/running/completed/failed/cancelled` worker records.
- [x] Atomic persistence, final result/error, durable completion notifications.
- [x] Illegal transitions and invalid IDs rejected.

Key commits: `8de81ae3`, `072feace`.

#### M1.2 - Worker Git isolation

- [x] One branch and runtime-managed worktree per worker.
- [x] Worktree assignment and base commit persisted/verified.
- [x] Cleanup preserves dirty work.

Key commits: `6795635d`, `84d34d46`.

#### M1.3 - Agent Manager API

- [x] Spawn/status/result/cancel/workspace/wait/ack orchestration.
- [x] Spawn remains pending until browser acceptance.
- [x] Short waits use the durable inbox without discarding full results.

Key commits: `d680dca3`, `b904a145`.

#### M1.4 - MCP agent tools

- [x] `agent_spawn`, `agent_status`, `agent_result`, `agent_wait`, `agent_cancel`, `worker_finish`.
- [x] Full-write lease required for preparation.
- [x] `worker_finish` verifies managed worktree and optional commit SHA.

Key commits: `88b981cb`, `99a61874`, `3052774e`, `0140853b`.

#### M1.5 - Completion notification piggyback

- [x] Concise worker completion notices attach to later normal Core MCP results.
- [x] Full results remain durable behind `agent_result`.
- [x] Notification failure cannot break Core tool success.

Key commits: `f3b9c80b`, `b0f92638`, `30cb2921`.

### M2 - ChatGPT Web workers

#### M2.1 - Worker-scoped Core routing

- [x] Opaque worker capabilities with hash-only persistence and revoke/expiry lifecycle.
- [x] Worker-specific in-memory `ToolContext` rooted at the managed worktree.
- [x] Explicit reused-Core tool allowlist.
- [x] Worker calls never mutate the main `sessions.json` project/lease state.

Key commits: `0a47070e`, `3d5886a8`, `66159afa`, `83166838`, `0140853b`.

#### M2.2 - Browser worker controller foundation

- [x] Durable browser-worker state separate from ChatGPT private conversation identity.
- [x] Optional local project -> ChatGPT Project routing.
- [x] Launch/cancel driver boundary; browser failure isolated from durable worker/workspace state.

Key commits: `e4ee5b39`, `2448e60c`, `33ea1bff`, `15fa47aa`.

#### M2.3 - ChatGPT worker launch/bootstrap

- [x] Dedicated Chrome profile + local CDP endpoint.
- [x] Project-route preference with standalone fallback.
- [x] Bootstrap carries task + scoped worker capability.
- [x] `pending -> running` only after successful bootstrap submission.
- [x] Failed launch revokes capability and remains retryable.
- [x] Explicit `agent_launch` and persistent project-route tools.

Representative commits: `6f0a4221`, `892cf5d5`, `bfba691b`, `9766a1ce`, `820a4091`.

#### M2.4 - Completion/recovery

- [x] `worker_finish` remains the durable completion source of truth.
- [x] `agent_stop` retires browser access while preserving branch/worktree/partial edits.
- [x] Lost CDP targets revoke old capabilities without fabricating worker failure.
- [x] `agent_launch` can recover the same durable running worker in a fresh browser attempt.
- [x] DOM completion is fallback-only diagnostic/recovery context; it never fabricates completed results.
- [x] Parallel-worker lifecycle/recovery coverage passes cross-platform.

Representative commits: `32e74b45`, `5feeb9ce`, `a73fa36d`, `bed891fb`, `056be27c`, `a2c2495d`, `08c206fb`.

### M3 - Windows Computer Use

#### M3.1 - Native input backend

- [x] Existing lease/policy/approval/kill-switch/audit plane preserved.
- [x] Persistent Windows helper with exact target activation and foreground verification.
- [x] Coordinate click, Unicode typing, key translation via native `SendInput` path.
- [x] Startup-ready handshake separates C# cold compile from per-request timeout.

Representative commits: `32c857d4`, `eac761b0`, `73997d09`, `c34d207e`.

#### M3.2 - Windows observation

- [x] Visible top-level window enumeration with ephemeral IDs.
- [x] App-window screenshot capture with `PrintWindow` + validated fallback.
- [x] DPI/scale metadata and request-time target privacy gates.
- [x] Before/after action evidence through the same capture adapter.

Representative commits: `13c8cb31`, `54a4f7ba`, `ce78688e`, `c5cc4fd1`, `9785a1c9`.

#### M3.3 - UIA semantic layer

- [x] Bounded Windows ControlView observation in a separate persistent helper.
- [x] Ephemeral observation/element IDs; no raw HWND/UIA runtime IDs exposed.
- [x] Invoke/Selection/Focus/ValuePattern actions with re-resolution before actuation.
- [x] UIA failure does not remove coordinate fallback.

Representative commits: `b31ebc41`, `79e31c86`, `362804cf`, `5c2844a7`.

#### M3.4 - Activity indicator

- [x] Native topmost click-through/no-activate indicator helper.
- [x] Screenshot exclusion/hide-restore fallback.
- [x] Ref-counted activity scope and parent watchdog.
- [x] Cosmetic indicator failure cannot block/authorize Computer Use.

Representative commits: `22e0773f`, `14cdef8d`, `bdedb955`, `e68b7eaa`.

#### M3.5 - VMware live smoke validation

- [x] Notepad semantic/coordinate interaction.
- [x] Explorer selection and Chrome address-bar/UIA interaction.
- [x] 125% and 150% DPI validation.
- [x] Minimized Notepad semantic observation.
- [x] Screenshot exclusion, edge-glow UX, and physical Esc cancellation.
- [x] Pointer/halo/ripple experiments removed from final indicator path.
- [x] Repeated runtime/session restart behavior validated.
- [x] Fixed Cloudflare Named Tunnel setting lookup across Process/User/Machine environment scopes.
- [x] Fixed `GetCurrentThreadId` DLL import (`kernel32.dll`); final live `windowPoint` click succeeded.

Final M3 tunnel/native-input CI: `34925521385`.

### M4 - Hooks

#### M4.1 - Hook engine foundation

- [x] Runtime-owned versioned `hooks.json`.
- [x] `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop` event vocabulary.
- [x] Direct argv command driver with `shell:false`, restricted environment, JSON stdin envelope.
- [x] Bounded cwd modes, timeouts, output capture, and deterministic sequential execution.
- [x] Hook failures never break healthy Core operations.

Final M4.1 CI: `34927688256`.

#### M4.2 - SessionStart

- [x] One `SessionStart` per created MCP server/session instance.
- [x] Bounded transport/remote/project metadata only.
- [x] State/config/hook failure remains best-effort.

Representative commits: `fd75e655`, `3c5f68b7`, `4401806c`, `e5a735c5`.

#### M4.3 - Tool lifecycle

- [x] `PreToolUse` / `PostToolUse` wrap the shared MCP tool boundary.
- [x] Raw arguments/results/secrets are not copied into lifecycle payloads.
- [x] Hook failure cannot veto or alter tool results.

Final M4.3 CI: `34977212167`.

#### M4.4 - Subagent lifecycle

- [x] `SubagentStart` emitted after durable `running` transition.
- [x] `SubagentStop` emitted after durable terminal transition.
- [x] Duplicate transitions do not duplicate hooks.
- [x] Durable state remains authoritative when hooks fail.

Final M4.4 CI: `34977859202`.

#### M4.5 - Ponytail worker integration

- [x] Ponytail remains an instruction-layer adapter, not a hook policy engine.
- [x] Default `FULL`; task-local `lite/full/ultra/off` directives supported.
- [x] Initial launch and recovery share the same adapter.
- [x] Durable worker task remains the original unmodified task.
- [x] Validation/security/error-handling/accessibility/user requirements cannot be simplified away.

Final M4 CI: `34984722276`.

### M5 - Extensions

#### M5.1 - Agent Skills foundation

- [x] Dependency-free `SKILL.md` metadata parser.
- [x] Global `<stateDir>/skills/` and project `<project>/.agents/skills/` roots with project-over-global precedence.
- [x] Bounded recursive discovery (depth 4, 256 directories per root) and deterministic collision diagnostics.
- [x] Discovery stops below a valid skill root so support directories do not become accidental skills.
- [x] Canonical root checks and symlink rejection for skill roots/directories/`SKILL.md`.
- [x] `SKILL.md` capped at 256 KiB; common VCS/dependency/cache directories skipped.
- [x] Registry stores metadata only; full skill content loads on demand.
- [x] Discovery never executes skill scripts or package-manager instructions.

Implementation commits: `3126c177`, `e9abe262`, `7a85f7f2`, `925804a9`, `1536944e`, `2cfe3377`, `1b0784dc`, `1465cca5`.

Final M5.1 CI: `34993848469`.

#### M5.2 - Skill management tools

- [x] Added fixed MCP tools: `skill_list`, `skill_view`, `skill_install`, `skill_update`, `skill_remove`.
- [x] `skill_list` exposes lightweight metadata only; `skill_view` loads one full `SKILL.md` on demand.
- [x] Added managed local-directory installs restricted to canonical paths inside the configured workspace.
- [x] Added HTTPS Git installs staged in a temporary clone with terminal prompts disabled and optional explicit ref checkout.
- [x] Git installs record the resolved commit before exporting a snapshot into managed skill storage.
- [x] Multi-skill repositories require an explicit `skillName`; direct single-skill roots are supported.
- [x] Added project/global target scopes; project-scoped mutation reuses the existing active-project write lease.
- [x] Managed provenance is stored under `<skill>/.chatgpt2codex/source.json` with source/ref/commit/install/update metadata.
- [x] Updates/removals operate only on runtime-managed installs; manual/project-authored skills are never overwritten or deleted.
- [x] Snapshot copying rejects symlinks/special entries, omits VCS metadata, and is bounded to 2048 files / 32 MiB.
- [x] No install/list/view/update path executes skill scripts or package-manager instructions.
- [x] Added local lifecycle, project-scope, multiple-skill, outside-workspace, credential-URL, unmanaged-skill, and MCP progressive-disclosure coverage.
- [x] Agent Skills tests are included in the Ubuntu/Windows focused CI set; macOS continues to run the full suite.

Representative implementation commits: `ab7183a0`, `ddf742ea`, `5df8f883`, `46bdfb71`, `f5d46268`, `167081ab`, `9fa2510d`, `5567e71b`, `bdcf1b00`.

Final M5.2 code CI: `34995875346` (Ubuntu, macOS, Windows all passed).

#### M5.3 - Skill activation

- [x] Added persistent runtime-owned skill activation state with independent global and active-project selection layers.
- [x] Added `skill_activate` and `skill_deactivate`; activation returns the selected bounded `SKILL.md` to the main ChatGPT agent immediately.
- [x] `skill_list` now exposes a bounded catalog with active-state metadata instead of exposing every skill body.
- [x] Catalog limits: 32 entries, approximately 6,000 metadata characters total, and 500 description characters per entry.
- [x] Effective activation is deterministic and capped at 3 skill names, 8,000 characters per `SKILL.md`, and 24,000 activated instruction characters combined.
- [x] Project-over-global package precedence is re-applied when activated instructions are loaded.
- [x] Activated instructions are appended only at browser-worker launch/recovery time; the durable worker task is never rewritten.
- [x] Initial launch and recovery use the same activation adapter and re-read current activation state.
- [x] Missing/stale optional activation content is skipped rather than fabricating durable worker failure.
- [x] Skill activation does not alter worker capability tokens, worker tool allowlists, Computer Use access, or external plugin access.
- [x] Added activation-state, precedence, stale-entry, main-agent lifecycle, oversized-skill, initial-worker, and recovery-worker coverage.

Representative implementation commits: `5de3de2e`, `208e8bc5`, `aa435211`, `dfa469af`, `a0207c9b`, `59e37eb6`.

Final M5.3 code CI: `34998597354` (Ubuntu, macOS, Windows all passed).

#### M5.4 - Skill resources and security

- [x] Added `skill_resource_read` for bounded non-executable reads from `references/`, `templates/`, and `assets/` only.
- [x] Resource paths reject absolute/traversal paths and symlink escapes; text reads are bounded and binary resources are returned only as bounded base64.
- [x] `scripts/` remains outside the resource-read allowlist and no skill script runner was introduced.
- [x] Added `skill_security_status` with provenance, trust classification (`unmanaged`, `managed-local`, `external-git`), and static-scan metadata without returning the instruction body.
- [x] External Git skill install/update staging is scanned before the prepared snapshot is placed into managed storage.
- [x] External skill activation is blocked before activation state is persisted when the static scan reports blocking findings.
- [x] Existing activated external skills are re-checked at browser-worker launch/recovery and skipped rather than injected when validation fails.
- [x] `skill_list`, `skill_view`, and activation flows surface trust/provenance metadata; unsafe external `skill_view` content is not exposed for instruction use.
- [x] Static checks cover obvious higher-priority instruction override, persistence/agent-config modification, broad destructive commands, destructive Git warnings, package-script execution instructions, and explicit data-exfiltration language.
- [x] Added focused resource/security/MCP/external-activation regressions and included them in cross-platform CI.

Representative implementation commits: `88ac2517`, `e2fbed65`, `54cd0ac1`, `b01815ef`, `6b7801f7`, `79c17833`, `43953177`, `7587094e`, `1300813d`, `58595ae8`, `ef60f445`, `d640350a`, `61113ab6`.

Final M5.4 code CI: `35002217812` (Ubuntu, macOS, Windows all passed, including Windows native/UIA/activity-indicator and launcher build coverage).

#### M5.5 - External MCP plugins

- [x] Added runtime-owned versioned `plugins.json` with a hard cap of 16 configured plugins.
- [x] Added local-only `plugin_register`, `plugin_set_enabled`, and `plugin_remove`; remote ChatGPT sessions cannot add or arm new network endpoints.
- [x] Added read-only `plugin_list`; registration is disabled by default and listing does not make network calls.
- [x] Plugin authentication headers store environment-variable names only; credential values are resolved in memory and are never persisted in plugin configuration.
- [x] Endpoint validation allows HTTPS and loopback HTTP only and rejects embedded URL credentials, query strings, and fragments.
- [x] Added bounded on-demand `plugin_discover` using the MCP Streamable HTTP client with enabled-only connections, timeouts, schema/catalog limits, and per-plugin error isolation.
- [x] Added fixed `plugin_call` proxy instead of dynamically registering external schemas into Core; calls require an explicit plugin id and exact remote tool name.
- [x] Plugin call arguments/results are bounded and plugin failures remain local to the invocation.
- [x] Worker-prefixed plugin inheritance remains disabled: worker mirrors still come only from `WORKER_CORE_TOOL_NAMES`, and no `worker_plugin_*` proxy is registered.
- [x] Added optional explicit plugin `skillSources` declarations for HTTPS Git sources; declarations are inert and never install/activate automatically.
- [x] Plugin-associated skills continue through the normal `skill_install` path and therefore reuse M5.1-M5.4 provenance, scanning, activation, resource, and script-disable boundaries.
- [x] Added cross-platform plugin registry, discovery, invocation, failure-isolation, and skill-source regression coverage.

Representative implementation commits: `e3ca6afc`, `f578645d`, `62ee8fd9`, `7558bde5`, `a84fb368`, `fb8c3a28`, `cb524aff`, `36804fc6`, `6d45b0f4`, `41d0b826`, `318900e4`, `ada4f3fa`.

Final M5.5 code CI: `35007895907` (Ubuntu, macOS, Windows all passed, including Windows native/UIA/activity-indicator and launcher build coverage).

## Planned next

The milestone plan in `docs/CUSTOM-RUNTIME-PLAN.md` ends at M5. No new feature milestone has been added implicitly.

Post-roadmap work should therefore be stabilization and real integration validation rather than widening scope automatically:

- [x] Run one live external MCP smoke test against a deliberately configured endpoint: local registration -> enable -> discovery -> explicit `plugin_call` -> disable/remove.
  - Verified by loopback Streamable HTTP MCP integration through the actual Core plugin tool handlers in commit `5fbc010b`; CI `35011189776` passed on Ubuntu, macOS, and Windows.
- [x] Run a declared plugin skill-source smoke test through the existing `skill_install` / `skill_activate` path.
  - Verified in commit `c99bee63`; CI `35013285118` passed on Ubuntu, macOS, and Windows.
  - The test registers an inert plugin `skillSources` declaration, confirms no install/activation occurs automatically, then explicitly routes the returned declaration through the normal `skill_install` path.
  - A test-only Git URL rewrite maps the declared HTTPS source to a temporary local repository, so the production Git clone/install path, resolved-commit provenance, `external-git` trust classification, static security scan, and `skill_activate` are all exercised deterministically without depending on a public Git service.
  - A marker script inside the fixture remains unexecuted across registration, install, security inspection, and activation.
- [x] Validate plugin configuration against the browser-worker capability/tool-registration path.
  - Verified in `f849dff0`; CI `35014499804` passed on Ubuntu, macOS, and Windows.
  - Configuring/enabling a plugin does not add any `worker_plugin_*` tool. Worker mirrors remain exactly derived from `WORKER_CORE_TOOL_NAMES`.
  - `dispatchWorkerCoreTool()` rejects `plugin_list`, `plugin_discover`, and `plugin_call` before worker capability use, so the worker capability itself cannot authorize plugin access.
  - This validation exposed the original shared remote catalog gap and motivated the dedicated worker transport.
- [x] Add a hard browser-worker MCP identity/catalog boundary while preserving main-agent plugin access.
  - Implemented a worker-only MCP server factory and dedicated `/mcp/worker` resource while keeping the normal main catalog on `/mcp`.
  - The worker catalog is exactly `worker_finish` plus `worker_*` mirrors derived from `WORKER_CORE_TOOL_NAMES`; unprefixed plugin/main tools are not registered on that transport.
  - Main and worker OAuth resource audiences are exact-matched at the HTTP boundary, and tracked MCP sessions are role-bound so tokens/session IDs cannot be replayed across routes.
  - The existing opaque worker capability remains the authority for each worker operation; the worker endpoint only narrows catalog exposure.
  - Real OAuth authorization-code + PKCE and Streamable HTTP MCP clients verify main plugin availability, worker plugin denial, worker protected-resource metadata, and cross-audience rejection in `src/server/worker-mcp-isolation.test.ts`.
  - Implementation/test HEAD `87f497f0`; CI `35017393064` passed on Ubuntu, macOS, and Windows.
- [x] Route browser-worker task messages through a dedicated ChatGPT worker custom app backed by `/mcp/worker`.
  - ChatGPT app selection is message-scoped, so the Chrome/CDP driver types `@ChatGPT To Codex Worker`, selects the exact app from ChatGPT's app picker, and then inserts/submits the task bootstrap.
  - The worker app name defaults to `ChatGPT To Codex Worker` and can be overridden with `CHATGPT2CODEX_WORKER_APP_NAME` when the installed custom app uses another exact display name.
  - If the worker app cannot be found, launch fails closed before task submission; it never silently falls back to the main `/mcp` app.
  - Initial launch and recovery share the same `BrowserWorkerDriver`, so both use the same worker-app routing rule.
  - Initial implementation/test commits `236994e7`, `8b0b8b07`, `1a50605f`; CI `35022343381` passed on Ubuntu, macOS, and Windows.
  - Live UI stabilization added subtitle-aware row matching (`415b8e3`, `5c886bb`), selected-state recovery (`8ccb755`, `1022fc1`, `c956c3d`), and actual inline-app DOM detection (`6179841e`, `f081c065`).
  - Setup/live-smoke procedure is documented in `docs/CHATGPT-WORKER-APP-SETUP.md`.
- [x] Live-validate the real connected ChatGPT worker custom app in the user's dedicated worker Chrome profile.
  - `ChatGPT To Codex Worker` was connected to the same public origin at `/mcp/worker` and completed OAuth.
  - Manual inspection in the dedicated worker profile confirmed the worker-only tool catalog and app visibility in the `@` picker.
  - Real DOM diagnostics (`904ab967`) showed ChatGPT renders the selected app as an inline `<a>` inside `#prompt-textarea`; the driver was corrected in `6179841e` and covered by `f081c065`.
  - CI `35045017337` passed on Ubuntu, macOS, and Windows after the final live-DOM fix.
  - The same pending durable worker `wrk_3fb5f6f7-43a7-47e5-9da1-5db1a90b086b` was repeatedly retried rather than replaced. Its final live run automatically selected the worker app, read `README.md`, reported the first heading `# c2c-smoke`, made no file changes, and completed through `worker_finish`.
  - This proves the primary connected worker-app path end-to-end. It does not separately prove a live `running` worker recovery after a lost/stopped browser target; that remains an optional follow-up although code/CI use the same routing driver for recovery.
- [ ] Optionally live-smoke a true running-worker browser recovery (`running` -> lost/stopped target -> recover same worker) through the dedicated worker app.
- [ ] Review the lease-restoration UX exposed during manual worker tests: remote MCP can raise to the permitted write lease for the task but cannot re-grant local-authority-only `control`; preserve the security boundary while reducing operational friction if possible.
- [ ] Keep CI green and fix integration defects discovered by stabilization before defining any new milestone.

## Update policy

Update this file whenever a unit is completed, blocked, materially redesigned, or moved in scope. Record verification and relevant commits before beginning the next unit.

Keep `docs/SESSION-HANDOFF.md` synchronized whenever a milestone/stabilization unit completes, the active unit or architectural direction changes, or a major live validation changes the next session's operational context.