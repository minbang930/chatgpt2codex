# Session Handoff

Operational handoff for continuing work on `chatgpt2codex` across ChatGPT sessions. Read this before making changes, then verify it against the live repository state. If this file and the repository disagree, the repository is authoritative and this file must be corrected as part of the work.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: provide a stable ChatGPT-Web-driven coding runtime that does not depend on local Codex quota while preserving the original reliable Core path.

Target architecture, in brief:

- ChatGPT Web main agent talks to a small, stable Core MCP surface.
- Existing Core remains the authority for project selection, leases, file/shell/git operations, policy, audit, and related safety checks.
- Durable Agent Manager state owns worker lifecycle/results.
- Full-write workers use isolated Git branches/worktrees and scoped worker capabilities rather than the main session state.
- Browser workers run through dedicated Chrome/CDP bootstrap and receive only an explicit worker Core tool allowlist.
- Windows Computer Use reuses the existing control lease/policy/audit plane.
- Hooks, Agent Skills, and external MCP plugins are optional extensions around Core, not alternate authorization systems.

See `docs/CUSTOM-RUNTIME-PLAN.md` for the detailed architecture.

## How to work with the user

The user prefers implementation-first progress.

- When the user says `진행해`, `이어가자`, `해줘`, or otherwise clearly authorizes the next unit, do not stop at a plan. Inspect the current repo state and perform the repo work in the same turn.
- Do not repeatedly ask for permission for steps already implied by an authorized unit.
- Work one coherent unit at a time. Do not blur several roadmap units into one large change.
- Complete each unit in this order: **implement -> run focused tests / CI -> fix failures -> update progress/handoff docs**.
- Prefer concrete results (diff, commit, CI status, defect found/fixed) over long speculative explanations.
- External implementations may be researched for good patterns, but avoid wholesale copies or large unnecessary frameworks.
- If live user validation is needed, provide directly runnable commands and an exact expected result.

## Engineering rules that should persist across sessions

- Core stability is more important than optional extensions.
- Reuse the existing authorization / lease / capability / durable-state boundaries. Do not create a parallel authorization system for a new feature.
- Durable state is the source of truth when a durable lifecycle already exists.
- Optional worker/browser/hook/skill/plugin failures must not break the normal Core coding path.
- Prefer the narrowest common implementation point that owns the behavior.
- Reuse existing code, native/platform facilities, and installed dependencies before adding new abstractions or dependencies.
- Do not weaken validation, security, data-integrity, accessibility, or explicitly requested behavior in the name of simplification.
- Windows is the active development target for Computer Use and new platform work. Preserve existing Ubuntu/macOS CI; do not expand macOS/Linux feature scope merely for parity.

## Ponytail worker policy

Ponytail is an instruction-layer coding policy in `src/agents/ponytail.ts`; it is not an authorization or hook policy engine.

- Default mode: `full`.
- First non-empty task line may select `ponytail lite|full|ultra|off` or `/ponytail lite|full|ultra|off`.
- The durable worker task remains the original user task. Ponytail adaptation is applied only to the text handed to the browser worker.
- Prefer reuse, native/direct solutions, minimal coherent diffs, and no speculative infrastructure.
- Never simplify away validation/security/data-loss safeguards/error handling/accessibility/user requirements.

## Milestone state

The original M0-M5 roadmap is complete. Detailed commit history belongs in `docs/CUSTOM-RUNTIME-PROGRESS.md`; keep this section compact.

- **M0 Baseline / CI**: fork baseline and cross-platform CI established.
- **M1 Durable multi-agent runtime**: durable worker state/inbox/results, Git branch/worktree isolation, Agent Manager/MCP tools, completion notification piggyback.
- **M2 ChatGPT Web workers**: worker-scoped Core routing/capabilities, dedicated Chrome/CDP bootstrap, ChatGPT Project routing, recovery/completion handling.
- **M3 Windows Computer Use**: native `SendInput`, screenshots, DPI handling, UIA semantic layer, activity indicator, VMware live smoke validation.
- **M4 Hooks**: runtime-owned best-effort lifecycle hooks for session/tool/subagent events; hooks are not authorization.
- **M5 Extensions**: Agent Skills foundation/management/activation/resources/security plus external MCP plugins.

Do not invent an M6 merely because M0-M5 are complete. Finish stabilization / real integration validation first.

## Agent Skills direction

Skills are `SKILL.md`-based Agent Skills, not merely external MCP servers. The implementation intentionally combines a small subset of useful ideas from:

- Hermes Agent: `skills_list` / `skill_view` progressive disclosure, GitHub-oriented skill lifecycle UX, external-skill trust/security checks.
- OpenClaw: safe filesystem boundaries, project-over-global precedence, temporary Git clone -> validation -> snapshot export, plugin-provided skill declarations, bounded prompt/context loading.

Current boundaries:

- global and project skill roots with project-over-global precedence;
- managed local/Git installs with provenance;
- activation is bounded and progressively disclosed;
- external Git skills are statically scanned before trusted instruction use;
- `references/`, `templates/`, and `assets/` may be read through the bounded resource API;
- **skill scripts are never automatically executed** and there is no generic skill script runner.

See `docs/SKILLS-DESIGN.md`.

## External MCP plugin direction

Plugins use runtime-owned `plugins.json` and a fixed proxy model rather than dynamically adding arbitrary remote schemas to Core.

- local-only registration/enable/remove controls;
- read-only list plus on-demand bounded discovery;
- explicit `plugin_call(pluginId, toolName, arguments)` proxy;
- HTTPS or loopback HTTP endpoints only;
- auth secrets are resolved from environment-variable references rather than stored values;
- plugin failures are isolated from Core;
- optional plugin `skillSources` declarations are inert until they pass through the normal skill install/security/activation path;
- **browser workers must not automatically inherit plugin tools**. Worker tools remain limited to the explicit `WORKER_CORE_TOOL_NAMES` surface.

See `docs/PLUGINS-DESIGN.md`.

## Decisions that are already closed unless the user explicitly reopens them

- Mouse pointer / halo / ripple Computer Use indicators were experimented with and removed. Do not reintroduce them by default.
- The current activity indicator is the subtle edge-glow design; treat it as complete unless a real defect is found or the user asks to change it.
- Windows coordinate-click foreground handling, including the `GetCurrentThreadId` import fix, has passed live VM validation. Do not redesign it without a regression.
- Worker plugin auto-inheritance is prohibited.
- Skill scripts must not auto-run merely because a repo/skill/plugin was opened or activated.
- Browser workers remain narrower in capability than the main agent.

## Current operational state

Latest substantive code/test baseline verified before this handoff update:

- Code/test commit: `5fbc010b7e16039debfc123a484283f1c2715ee0` (`test: cover full MCP plugin lifecycle smoke`)
- Green CI: GitHub Actions run `35011189776` (Ubuntu, macOS, Windows all passed)
- Immediately following progress-doc commit: `a821d60377fcc3fe6602590108c3b0610365c677`
- Phase: **Post-M5 stabilization / live integration validation**

The live loopback plugin lifecycle smoke is now complete. It starts a real Streamable HTTP MCP server and exercises the actual Core plugin tool handlers through:

`plugin_register (disabled) -> plugin_set_enabled(true) -> plugin_discover -> plugin_call -> plugin_set_enabled(false) -> disabled-call rejection -> plugin_remove -> plugin_list(empty)`

This closes the first stabilization checklist item. The docs-only handoff/progress commit may be newer than the substantive baseline listed above, so every new session must still check the actual branch HEAD and latest CI before editing.

### Active unit

Validate a declared plugin `skillSources` entry through the existing skill lifecycle without inventing a plugin-specific installer.

Target evidence:

`plugin skillSources declaration -> normal skill_install -> existing external-skill security/provenance checks -> skill_activate`

The declaration itself must remain inert: listing or discovering the plugin must not install or activate a skill automatically. Reuse the existing M5.1-M5.4 skill path and keep script execution disabled.

## Remaining stabilization work

In order, unless an integration defect changes priority:

1. **Completed:** live MCP plugin lifecycle smoke through the fixed Core proxy surface (`5fbc010b`, CI `35011189776`).
2. Validate a declared plugin skill source through the existing `skill_install -> security -> skill_activate` path.
3. With plugin configuration present, re-run representative main-agent + browser-worker flows and prove the worker still receives no plugin tools.
4. Run representative end-to-end main-agent/browser-worker regression and fix integration defects found.
5. Use a real external MCP service only when a deliberate endpoint is available and doing so adds evidence beyond the deterministic loopback integration test.
6. Define a new milestone only after stabilization is complete.

## Source-of-truth documents

Use these rather than duplicating history here:

- `docs/CUSTOM-RUNTIME-PROGRESS.md` - milestone/unit status and verification history.
- `docs/CUSTOM-RUNTIME-PLAN.md` - architecture and roadmap design.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` - Windows Computer Use design/validation boundaries.
- `docs/HOOKS-DESIGN.md` - hook engine semantics and safety model.
- `docs/SKILLS-DESIGN.md` - Agent Skills loader/lifecycle/security design.
- `docs/PLUGINS-DESIGN.md` - external MCP plugin configuration/proxy/security design.

## Handoff maintenance rule

Update `docs/SESSION-HANDOFF.md` whenever any of the following changes materially:

- a milestone or stabilization unit is completed;
- the active unit changes;
- an architectural/security boundary changes;
- a significant live validation succeeds or invalidates an earlier assumption;
- the branch's operational baseline moves in a way the next session must know.

Do not turn this into a chronological diary. Keep only the current operational context and point to the detailed progress/design documents for history.

## New-session start procedure

1. Read `docs/SESSION-HANDOFF.md`.
2. Read the current-status and planned-next sections of `docs/CUSTOM-RUNTIME-PROGRESS.md`.
3. Check the actual `dev/custom-runtime` branch HEAD on GitHub.
4. Check the latest GitHub Actions CI for that HEAD.
5. Compare the handoff's current state/active unit with the repository and CI.
6. If they match, continue the active unit immediately.
7. If they differ, trust the actual repository state, determine what changed, and update this handoff before proceeding.

A future user message consisting only of **`SESSION-HANDOFF.md 읽고 이어서 진행해`** should be sufficient to resume work using this procedure.
