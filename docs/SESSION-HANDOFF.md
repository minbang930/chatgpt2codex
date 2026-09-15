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

## Engineering rules that persist across sessions

- Core stability is more important than optional extensions.
- Reuse the existing authorization / lease / capability / durable-state boundaries. Do not create a parallel authorization system for a new feature.
- Durable state is the source of truth when a durable lifecycle already exists.
- Optional worker/browser/hook/skill/plugin failures must not break the normal Core coding path.
- Prefer the narrowest common implementation point that owns the behavior.
- Reuse existing code, native/platform facilities, and installed dependencies before adding new abstractions or dependencies.
- Do not weaken validation, security, data-integrity, accessibility, or explicitly requested behavior in the name of simplification.
- Windows is the active development target for Computer Use and new platform work. Preserve existing Ubuntu/macOS CI.

## Ponytail worker policy

Ponytail is an instruction-layer coding policy in `src/agents/ponytail.ts`; it is not an authorization or hook policy engine.

- Default mode: `full`.
- First non-empty task line may select `ponytail lite|full|ultra|off` or `/ponytail lite|full|ultra|off`.
- The durable worker task remains the original user task. Ponytail adaptation is applied only to the text handed to the browser worker.
- Prefer reuse, native/direct solutions, minimal coherent diffs, and no speculative infrastructure.
- Never simplify away validation/security/data-loss safeguards/error handling/accessibility/user requirements.

## Milestone state

The original M0-M5 roadmap is complete. Detailed history belongs in `docs/CUSTOM-RUNTIME-PROGRESS.md`.

- **M0 Baseline / CI**: fork baseline and cross-platform CI.
- **M1 Durable multi-agent runtime**: durable worker state/inbox/results, Git worktree isolation, Agent Manager/MCP tools, completion notification piggyback.
- **M2 ChatGPT Web workers**: worker-scoped Core routing/capabilities, Chrome/CDP bootstrap, ChatGPT Project routing, recovery/completion handling.
- **M3 Windows Computer Use**: native `SendInput`, screenshots/DPI, UIA semantic layer, activity indicator, VMware live validation.
- **M4 Hooks**: runtime-owned best-effort session/tool/subagent hooks; hooks are not authorization.
- **M5 Extensions**: Agent Skills plus external MCP plugins.

Do not invent an M6 merely because M0-M5 are complete. Finish stabilization / integration validation first.

## Agent Skills boundaries

- global `<stateDir>/skills/` and project `.agents/skills/`, with project-over-global precedence;
- managed local/Git installs with provenance;
- bounded progressive-disclosure activation;
- external Git skills are statically scanned before trusted instruction use;
- bounded non-executable resource reads from `references/`, `templates/`, and `assets/`;
- **skill scripts are never automatically executed** and there is no generic skill script runner.

See `docs/SKILLS-DESIGN.md`.

## External MCP plugin boundaries

- runtime-owned `plugins.json` with local-only register/enable/remove controls;
- read-only list plus bounded on-demand discovery;
- explicit fixed `plugin_call(pluginId, toolName, arguments)` proxy rather than dynamic remote schemas;
- HTTPS or loopback HTTP endpoints only;
- authentication values come from environment-variable references, not persisted secrets;
- plugin failures are isolated from Core;
- optional plugin `skillSources` are declarations only and remain inert until the normal skill lifecycle is explicitly used;
- **browser workers must not automatically inherit plugin tools**. Worker tools remain limited to the explicit `WORKER_CORE_TOOL_NAMES` surface.

See `docs/PLUGINS-DESIGN.md`.

## Decisions already closed unless the user reopens them

- Pointer/halo/ripple Computer Use indicators were removed. Do not reintroduce them by default.
- The current activity indicator is the subtle edge-glow design and is considered complete unless a real defect appears or the user asks to change it.
- Windows coordinate-click foreground handling, including the `GetCurrentThreadId` import fix, passed live VM validation.
- Worker plugin auto-inheritance is prohibited.
- Skill scripts must not auto-run because a repo/skill/plugin was listed, installed, or activated.
- Browser workers remain narrower in capability than the main agent.

## Current operational state

Phase: **Post-M5 stabilization / integration validation**.

Latest substantive integration baseline:

- Code/test commit: `c99bee6364bf7ce5ff08a22c23fc3a27f77ed3c1` (`test: validate plugin skill source lifecycle`)
- CI: GitHub Actions `35013285118` — **success** on Ubuntu, macOS, and Windows, including the existing Windows native/UIA/activity-indicator and launcher pipeline.

Completed stabilization evidence so far:

1. External MCP plugin lifecycle through actual Core handlers:
   `plugin_register -> enable -> discover -> plugin_call -> disable -> denied call -> remove`.
   Verified by `5fbc010b`; CI `35011189776`.
2. Plugin-declared skill-source lifecycle through the existing Skill system:
   `plugin skillSources declaration -> explicit skill_install -> real Git clone/provenance -> external-skill security scan -> skill_activate`.
   Verified by `c99bee63`; CI `35013285118`.
   - The plugin declaration remains inert: registration/listing does not install or activate the skill.
   - The integration fixture uses an HTTPS declaration with a test-only Git URL rewrite to a temporary local repository, so CI exercises the production Git clone/install/provenance path without depending on a public network service.
   - Trust is verified as `external-git`, resolved commit provenance is checked, the static scan must be complete with no blocking finding, and a marker script proves skill scripts are not executed during install or activation.

### Active unit

Validate **main-agent vs browser-worker plugin capability isolation while plugin configuration exists**.

Target evidence:

- main-agent Core still exposes/uses the configured `plugin_*` surface as designed;
- worker tool registration remains derived only from the existing explicit `WORKER_CORE_TOOL_NAMES` allowlist;
- configuring/enabling a plugin does not add `plugin_list`, `plugin_discover`, `plugin_call`, or any other plugin tool to a browser worker;
- a representative worker-capability/tool-registration flow proves plugin configuration cannot widen worker authority;
- do not add a worker plugin proxy merely to make the test convenient.

If this validation finds a real isolation gap, fix that gap at the existing common capability/tool-registration boundary, then rerun cross-platform CI before moving on.

## Remaining stabilization work

In order, unless a discovered defect changes priority:

1. **Completed:** fixed Core external MCP lifecycle smoke (`5fbc010b`, CI `35011189776`).
2. **Completed:** plugin `skillSources` -> normal external Git Skill lifecycle smoke (`c99bee63`, CI `35013285118`).
3. Validate representative main-agent + browser-worker flows with plugin configuration present and prove browser workers still receive no plugin tools.
4. Keep CI green and fix integration defects found by those smoke tests.
5. Use a real public/external MCP service only when a deliberate endpoint is available and it adds evidence beyond deterministic integration coverage.
6. Define a new milestone only after stabilization is complete.

## Source-of-truth documents

- `docs/CUSTOM-RUNTIME-PROGRESS.md` - milestone/unit status and verification history.
- `docs/CUSTOM-RUNTIME-PLAN.md` - architecture and roadmap design.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` - Windows Computer Use boundaries.
- `docs/HOOKS-DESIGN.md` - hook engine semantics and safety model.
- `docs/SKILLS-DESIGN.md` - Agent Skills lifecycle/security design.
- `docs/PLUGINS-DESIGN.md` - external MCP plugin configuration/proxy/security design.

## Handoff maintenance rule

Update this file whenever a milestone/stabilization unit completes, the active unit changes, an architecture/security boundary changes, or a major live validation changes the next session's operational context. Keep it operational rather than chronological; detailed history belongs in the progress/design documents.

## New-session start procedure

1. Read `docs/SESSION-HANDOFF.md`.
2. Read the current-status and planned-next sections of `docs/CUSTOM-RUNTIME-PROGRESS.md`.
3. Check the actual `dev/custom-runtime` branch HEAD on GitHub.
4. Check the latest GitHub Actions CI for that HEAD.
5. Compare the handoff with the repository/CI; if they differ, trust the repository and correct the handoff.
6. If they match, continue the active unit immediately.

A future user message consisting only of **`SESSION-HANDOFF.md 읽고 이어서 진행해`** should be sufficient to resume work.
