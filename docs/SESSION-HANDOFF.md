# Session Handoff

Operational handoff for continuing `chatgpt2codex` across ChatGPT sessions. Read this before making changes, then verify it against the live repository and latest CI. If this file and the repository disagree, the repository is authoritative and this file must be corrected as part of the work.

## Project identity

- Repository: `minbang930/chatgpt2codex`
- Active branch: `dev/custom-runtime`
- Upstream: `ezBuilder/chatgpt2codex`
- Goal: stable ChatGPT-Web-driven coding runtime without depending on local Codex quota while preserving the original Core authorization/project/file/shell/git path.

The original M0-M5 roadmap is complete. Do not invent an M6 automatically; finish stabilization/live integration validation first.

## How to work with the user

The user prefers implementation-first progress.

- When the user says `진행해`, `이어가자`, `해줘`, or otherwise authorizes the next unit, inspect current repo/CI and do the repo work in the same turn.
- Do not repeatedly ask permission for already-authorized work.
- Work one coherent unit at a time.
- Per unit: **implement -> focused tests/CI -> fix failures -> update progress/handoff docs**.
- Prefer concrete state/change/commit/CI reports over speculative explanation.
- Windows is the active platform target for live validation; preserve Ubuntu/macOS CI.
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
- task-local: `ponytail lite|full|ultra|off` or slash variants
- durable worker task remains unchanged; adaptation is applied only to browser-worker instructions
- prefer reuse/native/direct solutions and minimal coherent diffs without weakening validation/security/error handling/accessibility/data integrity.

## Completed stabilization evidence

### External MCP / Skills

1. Actual Core plugin lifecycle:
   `plugin_register -> enable -> discover -> plugin_call -> disable -> denied call -> remove`.
   - commit `5fbc010b`
   - CI `35011189776` green on Ubuntu/macOS/Windows.
2. Plugin `skillSources` declaration through normal external Git Skill lifecycle:
   `declaration -> explicit skill_install -> Git provenance/security scan -> skill_activate`.
   - commit `c99bee63`
   - CI `35013285118` green.
   - declaration remains inert and fixture scripts remain unexecuted.
3. Plugin configuration vs worker capability registration:
   - no `worker_plugin_*`
   - worker mirrors remain exactly derived from `WORKER_CORE_TOOL_NAMES`
   - dispatcher rejects plugin tools before worker capability use.
   - commit `f849dff0`
   - CI `35014499804` green.

### Hard worker MCP server isolation

The shared remote catalog gap was closed server-side.

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

Properties already regression-tested:

- dedicated worker-only `McpServer` factory;
- worker catalog excludes unprefixed plugin/main tools, Skills, Agent Manager, Computer Use, and ordinary file/shell/git tools;
- `/mcp` retains main-agent plugin proxies;
- OAuth audiences are exact-matched between `/mcp` and `/mcp/worker`;
- MCP sessions are role-bound (`main|worker`) so session IDs cannot cross routes;
- worker token/session cannot be replayed into the main endpoint and vice versa;
- existing opaque `workerToken` remains the per-worker repository authority.

Implementation/test HEAD for this boundary: `87f497f0`.
CI `35017393064`: Ubuntu/macOS/Windows all green.

### ChatGPT message-level worker app routing

The Chrome/CDP browser-worker driver now explicitly selects the worker custom app before submitting the task message.

Current behavior in `src/agents/chrome-cdp.ts`:

1. open mapped ChatGPT Project or standalone ChatGPT;
2. wait for the composer;
3. type `@ChatGPT To Codex Worker`;
4. select the exact matching app from ChatGPT's visible app picker;
5. append the worker bootstrap + scoped capability;
6. submit only after worker-app selection succeeds.

Important properties:

- Default worker app display name: `ChatGPT To Codex Worker`.
- Override exact installed name with `CHATGPT2CODEX_WORKER_APP_NAME`.
- If the worker app is missing from the `@` picker, launch **fails closed before task submission**. It does not fall back to the main `/mcp` app.
- Initial launch and recovery use the same browser driver and therefore the same routing rule.
- The bootstrap still requires `workerToken` on every `worker_*` call; selecting the app does not grant repository authority by itself.
- Main-agent app remains independent on `/mcp`.

Implementation/test commits:

- `236994e7` - browser-worker worker-app selection/routing
- `8b0b8b07` - message-routing tests
- `1a50605f` - corrected test fake to distinguish suggestion DOM from composer readiness

Code CI `35022343381`: **success on Ubuntu, macOS, and Windows**, including Windows native/UIA/activity-indicator/build/launcher pipeline.

Setup/runbook:

- `docs/CHATGPT-WORKER-APP-SETUP.md`
- `docs/CHATGPT-PROJECT-WORKER-ROUTING.md`

The required ChatGPT configuration is two custom apps against the same public origin:

```text
ChatGPT To Codex        -> <public-origin>/mcp
ChatGPT To Codex Worker -> <public-origin>/mcp/worker
```

Both use the existing Owner Token OAuth flow. If the worker app has a different display name, set `CHATGPT2CODEX_WORKER_APP_NAME` to that exact name.

## Active unit

**Live-validate the real connected ChatGPT worker custom app in the user's dedicated worker Chrome profile.**

This is the remaining evidence gap. CI proves the server boundary and deterministic CDP routing logic, but this session does not have the user's local ChatGPT worker Chrome/runtime control surface, so do not claim live UI success yet.

Live validation should prove all of the following simultaneously:

1. `ChatGPT To Codex Worker` is connected to `<public-origin>/mcp/worker` and visible in the dedicated worker profile's `@` picker.
2. A representative `agent_spawn` / `agent_launch` causes the browser driver to select that worker app and submit the task.
3. Worker can call `worker_project_rules` and another allowed `worker_*` tool using the scoped token.
4. Worker completes through `worker_finish`; durable `agent_result` remains correct.
5. Worker does not receive main plugin proxies, ordinary main file/shell/git tools, Computer Use, Skills, or Agent Manager from its worker app.
6. Parent/main ChatGPT app stays on `/mcp` and keeps its normal configured plugin surface.
7. Recovery of the same durable worker follows the same worker-app selection path.

Do not weaken this by using timing heuristics, "next connection is worker", first-call role inference, or prompt compliance. The explicit worker app + `/mcp/worker` OAuth/catalog boundary is the intended design.

## Remaining stabilization work

In order unless a real defect changes priority:

1. **Completed:** external MCP full lifecycle smoke (`5fbc010b`, CI `35011189776`).
2. **Completed:** plugin skill-source -> normal Skill lifecycle (`c99bee63`, CI `35013285118`).
3. **Completed:** plugin vs worker capability registration (`f849dff0`, CI `35014499804`).
4. **Completed:** hard worker MCP server/catalog/OAuth boundary (`87f497f0`, CI `35017393064`).
5. **Completed in code/CI:** browser driver explicitly selects dedicated worker app per task message (`236994e7` / `1a50605f`, CI `35022343381`).
6. **Active:** live user-environment smoke of the connected worker custom app and representative launch/recovery flow.
7. Keep CI green and fix any live integration defect before considering a new milestone.

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
6. If they match, continue the active unit immediately.

A future user message consisting only of **`SESSION-HANDOFF.md 읽고 이어서 진행해`** should be enough to resume.
