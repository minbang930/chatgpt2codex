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
- Browser-worker repository authority is generated only from the explicit `WORKER_CORE_TOOL_NAMES` allowlist.
- Remote main and worker MCP transports are now separated: `/mcp` is the main-agent resource; `/mcp/worker` exposes only `worker_*` plus `worker_finish`.
- Windows Computer Use reuses the existing control lease/policy/audit plane.
- Hooks, Agent Skills, and external MCP plugins are optional extensions around Core, not alternate authorization systems.

Important current stabilization caveat: the server-side worker transport/catalog boundary is implemented, but a real ChatGPT browser-worker conversation must still be routed to the `/mcp/worker` connector/resource. A conversation connected to `/mcp` is intentionally a main-agent session. See **Active unit** below.

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
- `dispatchWorkerCoreTool()` rejects plugin tools outside the worker allowlist before capability use;
- main remote sessions use `/mcp` and keep their fixed plugin proxies;
- isolated worker remote sessions use `/mcp/worker`, whose catalog is exactly `worker_finish` plus mirrors derived from `WORKER_CORE_TOOL_NAMES`;
- exact OAuth resource-audience checks and role-bound MCP sessions prevent main/worker token or session replay across those routes.

The worker endpoint narrows the catalog; the opaque durable `workerToken` remains the authorization for a particular worker/worktree. Do not confuse endpoint selection with worker authority.

See `docs/PLUGINS-DESIGN.md`.

## Decisions already closed unless the user reopens them

- Pointer/halo/ripple Computer Use indicators were removed. Do not reintroduce them by default.
- The current activity indicator is the subtle edge-glow design and is considered complete unless a real defect appears or the user asks to change it.
- Windows coordinate-click foreground handling, including the `GetCurrentThreadId` import fix, passed live VM validation.
- Do not add plugin tools to `WORKER_CORE_TOOL_NAMES` and do not create a `worker_plugin_*` proxy merely to simplify tests.
- Skill scripts must not auto-run because a repo/skill/plugin was listed, installed, or activated.
- Browser workers remain narrower in capability than the main agent.
- Do not globally disable main-agent plugin proxies while any worker exists.
- Do not replace authenticated worker endpoint routing with prompt text, timing heuristics, "next connection is worker" state, or first-tool-call role inference.
- Keep `/mcp` for the main agent and `/mcp/worker` for worker-only remote catalog use.

## Current operational state

Phase: **Post-M5 stabilization / integration validation**.

Latest completed substantive implementation validation:

- Implementation/test HEAD: `87f497f03a83aa12d49eac70105479d3e5fabf19` (`test: assert worker rejects plugin call result`).
- CI: GitHub Actions `35017393064` — **success** on Ubuntu, macOS, and Windows.
- Server boundary implementation sequence:
  - `f2d03f0e` — worker-only MCP server factory;
  - `a9888c70` — `/mcp/worker`, exact OAuth resource audiences, role-bound sessions;
  - `4ea9693c` — worker-only catalog regression;
  - `7bbeabc9` — real OAuth + Streamable HTTP main/worker isolation E2E;
  - `87f497f0` — correct MCP tool-not-found assertion semantics.
- Plugin design updated after validation to describe the server boundary and remaining ChatGPT-side routing requirement.

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
4. Hard server-side main/worker MCP catalog isolation:
   - `/mcp` retains the main-agent catalog including configured plugin proxies;
   - `/mcp/worker` exposes only `worker_*` plus `worker_finish`;
   - worker protected-resource metadata advertises the worker resource;
   - main and worker OAuth tokens cannot be replayed against the opposite endpoint;
   - MCP session IDs are role-bound and cannot cross routes;
   - calling an unregistered main/plugin tool through the worker transport returns MCP tool-not-found;
   - the existing worker capability still gates every actual worker operation.
   Verified by `87f497f0`; CI `35017393064`.

### Active unit

Validate and wire the **ChatGPT-side browser-worker connector routing** so actual worker conversations use `/mcp/worker` while the parent/main-agent conversation continues to use `/mcp`.

The server side is already ready. The remaining integration problem is that the Chrome/CDP bootstrap currently submits a worker prompt/capability into ChatGPT but cannot securely switch the conversation's installed MCP connector URL by prompt text.

Required properties for this next unit:

- a real browser-worker ChatGPT conversation must connect through the `/mcp/worker` resource, not the main `/mcp` connector;
- the main-agent ChatGPT connection must remain on `/mcp` and retain its plugin proxy surface;
- a worker ChatGPT-side Project/app/connector context must not simultaneously expose the main `/mcp` connector in a way that defeats the server boundary;
- initial launch and recovery must use the same routing rule;
- routing must compose with the existing opaque worker capability rather than replacing it;
- do not infer worker identity from prompt compliance, connection timing, or first tool call;
- if ChatGPT's connector model cannot programmatically choose the endpoint per worker, prefer an explicit separately configured worker connector/Project context and document the operational prerequisite rather than weakening the server boundary.

Inspect the current ChatGPT Project/connector assumptions first. If a deterministic automated test can cover routing metadata without relying on ChatGPT UI internals, add it. Then perform a representative live worker launch when the configured worker connector is available.

## Remaining stabilization work

In order, unless a discovered defect changes priority:

1. **Completed:** fixed Core external MCP lifecycle smoke (`5fbc010b`, CI `35011189776`).
2. **Completed:** plugin `skillSources` -> normal external Git Skill lifecycle smoke (`c99bee63`, CI `35013285118`).
3. **Completed:** configured plugin vs worker-prefixed capability validation (`f849dff0`, CI `35014499804`); this exposed the original shared remote catalog gap.
4. **Completed:** hard server-side `/mcp` versus `/mcp/worker` catalog/auth/session isolation (`87f497f0`, CI `35017393064`).
5. Route and live-validate actual browser-worker ChatGPT sessions through `/mcp/worker`, preserving `/mcp` for the main agent.
6. Run a representative end-to-end main-agent/browser-worker regression after ChatGPT-side routing is in place.
7. Use a real public/external MCP service only when a deliberate endpoint is available and it adds evidence beyond deterministic integration coverage.
8. Define a new milestone only after stabilization is complete.

## Source-of-truth documents

- `docs/CUSTOM-RUNTIME-PROGRESS.md` - milestone/unit status and verification history.
- `docs/CUSTOM-RUNTIME-PLAN.md` - architecture and roadmap design.
- `docs/WINDOWS-COMPUTER-USE-DESIGN.md` - Windows Computer Use boundaries.
- `docs/HOOKS-DESIGN.md` - hook engine semantics and safety model.
- `docs/SKILLS-DESIGN.md` - Agent Skills lifecycle/security design.
- `docs/PLUGINS-DESIGN.md` - external MCP plugin configuration/proxy/security design and the worker transport boundary.

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