# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M5 - Extensions**

Active unit: **M5.2 - Skill management tools (next)**

Detailed design documents:

- `docs/WINDOWS-COMPUTER-USE-DESIGN.md`
- `docs/HOOKS-DESIGN.md`
- `docs/SKILLS-DESIGN.md`

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

- [x] Added a dependency-free `SKILL.md` parser for the top-level Agent Skills metadata required by discovery (`name`, `description`, inline lists, quoted/folded scalars).
- [x] Added global `<stateDir>/skills/` and project `<project>/.agents/skills/` roots with project-over-global precedence.
- [x] Added bounded recursive discovery (depth 4, 256 directories per root) and deterministic collision diagnostics.
- [x] Discovery stops below a valid skill root, so `references/`, `templates/`, `assets/`, and `scripts/` do not become accidental standalone skills.
- [x] Added safe full-skill loading with canonical root checks; skill roots/directories and `SKILL.md` symlinks are rejected.
- [x] `SKILL.md` is capped at 256 KiB and common VCS/dependency/cache directories are skipped.
- [x] Registry metadata excludes the full skill body; full `SKILL.md` content is loaded only on demand.
- [x] No discovery/install path executes skill scripts or package-manager instructions.
- [x] Added parser, precedence, nested-discovery, on-demand-load, outside-root, and size-limit tests.
- [x] Added `docs/SKILLS-DESIGN.md` and revised the main roadmap from "Plugins" to the broader M5 "Extensions" phase based on Hermes/OpenClaw research.

Implementation commits: `3126c177`, `e9abe262`, `7a85f7f2`, `925804a9`, `1536944e`, `2cfe3377`, `1b0784dc`, `1465cca5`.

## Planned next

### M5.2 - Skill management tools

- [ ] Add `skill_list` and `skill_view` as progressive-disclosure MCP tools.
- [ ] Add local/Git install, remove, and update lifecycle.
- [ ] Support project/global install target scope.
- [ ] Record source/ref/resolved-commit/install-time provenance.
- [ ] Stage Git sources in a temporary location and export validated content into managed skill storage rather than using a mutable checkout live.
- [ ] Keep executable skill content disabled by default.

Later M5 units:

- M5.3: main-agent/worker skill activation with bounded catalogs.
- M5.4: support resources + external-skill security/trust checks.
- M5.5: separate external MCP Plugins connector and optional plugin-provided skills.

## Update policy

Update this file whenever a unit is completed, blocked, materially redesigned, or moved in scope. Record verification and relevant commits before beginning the next unit.
