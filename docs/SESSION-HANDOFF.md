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
- Browser-worker `worker_*` repository authority is generated only from the explicit `WORKER_CORE_TOOL_NAMES` allowlist.
- Windows Computer Use reuses the existing control lease/policy/audit plane.
- Hooks, Agent Skills, and external MCP plugins are optional extensions around Core, not alternate authorization systems.

Important current stabilization caveat: the worker-prefixed capability surface is narrow, but the browser-worker ChatGPT connection still uses the same remote `/mcp` catalog as the main ChatGPT connection. That shared catalog currently contains unprefixed main-agent plugin proxy tools. See **Active unit** below.

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
- plugin configuration does not add `worker_plugin_*` tools or widen `WORKER_CORE_TOOL_NAMES`;
- `dispatchWorkerCoreTool()` rejects plugin tools outside the worker allowlist before capability use.

Do **not** currently claim that a browser-worker ChatGPT session is server-side unable to invoke all unprefixed plugin proxies. The shared remote MCP catalog gap described below must be closed first.

See `docs/PLUGINS-DESIGN.md`.

## Decisions already closed unless the user reopens them

- Pointer/halo/ripple Computer Use indicators were removed. Do not reintroduce them by default.
- The current activity indicator is the subtle edge-glow design and is considered complete unless a real defect appears or the user asks to change it.
- Windows coordinate-click foreground handling, including the `GetCurrentThreadId` import fix, passed live VM validation.
- Do not add plugin tools to `WORKER_CORE_TOOL_NAMES` and do not create a `worker_plugin_*` proxy merely to simplify tests.
- Skill scripts must not auto-run because a repo/skill/plugin was listed, installed, or activated.
- Browser workers remain narrower in capability than the main agent.
- Do not solve the shared plugin-catalog gap by globally disabling main-agent plugin proxies while any worker exists.

## Current operational state

Phase: **Post-M5 stabilization / integration validation**.

Latest completed substantive validation:

- Code/test commit: `f849dff0f369f8dae1a9d52aaf741c1004da5302` (`test: verify plugin worker capability isolation`)
- CI: GitHub Actions `35014499804` — **success** on Ubuntu, macOS, and Windows.
- Plugin design clarification: `6afafd3ad9ad857f1fb24aa6691f5a0272dd7332`.
- Progress update: `3906172c98b19667f63ebe7e7fd64b836ee9630e`.

Completed stabilization evidence so far:

1. External MCP plugin lifecycle through actual Core handlers:
   `plugin_register -> enable -> discover -> plugin_call -> disable -> denied call -> remove`.
   Verified by `5fbc010b`; CI `35011189776`.
2. Plugin-declared skill-source lifecycle through the existing Skill system:
   `plugin skillSources declaration -> explicit skill_install -> real Git clone/provenance -> external-skill security scan -> skill_activate`.
   Verified by `c99bee63`; CI `35013285118`.
   - Declaration remains inert.
   - Production Git clone/provenance/security paths are exercised deterministically with a test-only HTTPS URL rewrite to a temporary local repository.
   - Skill scripts remain unexecuted.
3. Plugin configuration against worker capability/tool registration:
   - main-agent fixed plugin proxies remain registered;
   - configured plugins do not create `worker_plugin_*` mirrors;
   - worker mirrors remain exactly derived from `WORKER_CORE_TOOL_NAMES`;
   - `dispatchWorkerCoreTool()` rejects `plugin_list`, `plugin_discover`, and `plugin_call` before worker capability use.
   Verified by `f849dff0`; CI `35014499804`.

### Stabilization finding: shared remote catalog gap

The same validation found a real isolation gap relative to the stronger wording previously used in the design docs.

Current transport behavior:

```text
main ChatGPT session -----------\
                                 -> same remote /mcp server -> normal remote tools/list
browser-worker ChatGPT session -/
```

For every remote MCP initialize, `src/server/http.ts` calls `createServer({ ...ctx, remote: true })`. The connection currently carries no authenticated role/session identity that tells Core whether the caller is the main ChatGPT conversation or a browser-worker conversation.

Consequences:

- the hard `worker_*` capability path is correctly narrow;
- no `worker_plugin_*` tool exists;
- but shared remote `tools/list` still contains unprefixed `plugin_list`, `plugin_discover`, and `plugin_call`;
- the browser bootstrap tells a worker to use `worker_*` tools, but prompt text is not a server-side authorization boundary for those shared unprefixed proxies.

This is now captured by `src/plugins/worker-isolation.integration.test.ts` so future work cannot accidentally confuse worker-capability isolation with remote-catalog isolation.

### Active unit

Close the **hard browser-worker MCP catalog isolation gap** without breaking normal main-agent plugin use.

Required properties for the fix:

- Core must be able to identify an authenticated browser-worker MCP session before catalog generation/invocation.
- Browser-worker sessions must receive a worker-only tool catalog; unprefixed `plugin_list`, `plugin_discover`, `plugin_call`, normal file/shell/git tools, Computer Use, and other main-agent-only tools must not be callable merely because they share the same server process.
- Reuse the existing durable worker capability model rather than creating an unrelated second authority system.
- A dedicated worker MCP endpoint/credential or an equivalent authenticated worker-session role is acceptable if it cleanly composes with the existing worker token lifecycle.
- Main-agent remote sessions must retain their configured plugin proxy surface.
- Do not rely on bootstrap prompt compliance as the authorization boundary.
- Do not add worker plugin access as part of this fix.

Before implementing a broad transport change, inspect the current MCP/OAuth/bootstrap connection model and choose the smallest coherent place to bind worker identity to a remote MCP session. Add focused tests that prove both sides simultaneously: main-agent plugin proxies remain available, while an authenticated worker session cannot list or call them.

## Remaining stabilization work

In order, unless a discovered defect changes priority:

1. **Completed:** fixed Core external MCP lifecycle smoke (`5fbc010b`, CI `35011189776`).
2. **Completed:** plugin `skillSources` -> normal external Git Skill lifecycle smoke (`c99bee63`, CI `35013285118`).
3. **Completed:** configured plugin vs worker-prefixed capability validation (`f849dff0`, CI `35014499804`); this found the shared remote catalog gap.
4. Close and regression-test the hard browser-worker MCP catalog isolation gap while preserving main-agent plugin access.
5. Run representative end-to-end main-agent/browser-worker regression after the isolation fix.
6. Use a real public/external MCP service only when a deliberate endpoint is available and it adds evidence beyond deterministic integration coverage.
7. Define a new milestone only after stabilization is complete.

## Source-of-truth documents

- `docs/CUSTOM-RUNTIME-PROGRESS.md` - milestone/unit status and verification history.
- `docs/CUSTOM-RUNTIME-PLAN.md` - architecture and roadmap design.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` - Windows Computer Use boundaries.
- `docs/HOOKS-DESIGN.md` - hook engine semantics and safety model.
- `docs/SKILLS-DESIGN.md` - Agent Skills lifecycle/security design.
- `docs/PLUGINS-DESIGN.md` - external MCP plugin configuration/proxy/security design, including the current shared-catalog limitation.

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