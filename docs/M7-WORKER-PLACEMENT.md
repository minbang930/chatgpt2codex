# M7 Worker Placement Policy

Status: **complete**

## Goal

Allow the Windows EXE to control where newly created ChatGPT Web workers live without changing repository authority. A configured Worker ChatGPT Project URL must force all new workers into that Project. When the field is blank, placement remains dynamic and may be standalone, explicitly requested per worker, or inherited from the existing local-project mapping.

## Contract

```text
existing durable Worker placement (recovery)
  > EXE fixed Worker Project URL
  > agent_spawn per-worker placement
  > local-project -> ChatGPT-Project mapping
  > standalone ChatGPT
```

A route becomes durable once resolved for the Worker. Recovery/browser attempts reuse that Worker placement rather than re-reading mutable settings and moving the Worker. For compatibility, when neither fixed nor explicit per-worker placement is present, the project mapping remains deferred until first launch so `agent_project_route_set` can still run between spawn and launch.

## Windows launcher

The Settings dialog contains `Worker ChatGPT Project URL`.

- Blank: automatic/dynamic placement.
- Non-empty valid `https://chatgpt.com/...` URL: every new Worker is forced into that Project.
- The value is persisted as `WorkerProjectUrl` and passed to the runtime as `CHATGPT2CODEX_WORKER_PROJECT_URL`.
- Invalid non-ChatGPT URLs are rejected.

## Per-worker placement

With no fixed EXE URL, `agent_spawn` may request:

```text
placement.mode = standalone
```

or:

```text
placement.mode = project
placement.projectUrl = https://chatgpt.com/.../project
```

This is independent of model/reasoning execution intent and does not grant any repository or MCP authority.

## Implementation

Relevant implementation sequence:

- `79be0f6e5587ec606ebe365a7e9dca234cdff790` — fixed EXE/runtime placement plus durable browser placement state and tests.
- `411a2868f3198f31b6236fa79fbcdfeded9db9a8` — explicit per-worker Project/standalone placement requests.
- `37db3f64bb905982134aa58631c215713b7c8062` — preserve deferred `agent_project_route_set` compatibility.
- final tested tree: `1eaf8fa75c24bf814b37090e5f0b4a02bfabb7bd`.

Primary changed source/tests:

- `src/agents/browser-controller.ts`
- `src/agents/manager.ts`
- `src/server/agent-tools.ts`
- `src/agents/browser-placement-policy.test.ts`
- `src/agents/manager-placement.test.ts`
- `windows/ChatGPTToCodexLauncher.cs`

## Automated validation

Final GitHub Actions run `35175254790` on `1eaf8fa75c24bf814b37090e5f0b4a02bfabb7bd`:

- Ubuntu: success — typecheck, agent/platform-safe tests, build.
- macOS: success — typecheck, full test, build.
- Windows: success — typecheck, Agent tests, native/UIA/activity/public-host/startup helper tests, Node build, and Windows launcher build.

An intermediate regression was caught by CI: pinning the default standalone route at spawn prevented the established `agent_spawn -> agent_project_route_set -> agent_launch` flow. The final implementation only pins at spawn when a fixed EXE URL or explicit per-worker placement exists; otherwise mapping resolution remains deferred until first launch.

## Live Windows validation

### Fixed URL, no explicit Project request

After pulling/building locally, the EXE setting was populated and a fresh chat requested a Worker without mentioning placement. The Worker was created inside the configured ChatGPT Project.

### Fixed URL overrides per-worker standalone

Worker `wrk_0dc5fe1c-d919-46a2-9f3e-4cbbce5995b8`:

- requested placement: `standalone`;
- actual route: `project`;
- actual URL: `https://chatgpt.com/g/g-p-6aab2b62ecc8819190c854618ecffaba-test-project-1/project`;
- launch: success on attempt 1;
- durable status: `completed`;
- README title: `# c2c-smoke`;
- `changedFiles=[]`.

This proves the fixed EXE setting outranks a conflicting per-worker request.

### Blank EXE setting + explicit standalone

Worker `wrk_f3f6ddb0-a6f5-4706-9090-6aa04b8e0900`:

- requested placement: `standalone`;
- actual route: `standalone`;
- launch: success on attempt 1;
- durable status: `completed`;
- README title: `# c2c-smoke`;
- `changedFiles=[]`.

### Blank EXE setting + explicit Project

Worker `wrk_caa6c047-cd2f-4ff7-bf6c-f750fdcd5f2e`:

- requested placement: `project`;
- requested URL: `https://chatgpt.com/g/g-p-6aab2b62ecc8819190c854618ecffaba/project`;
- actual route: `project`;
- actual URL matched exactly;
- launch succeeded on attempt 1 and the task was submitted.

The follow-up `agent_wait` was blocked by the calling system, so final README/changedFiles were not collected for this worker. That does not affect placement validation because the browser route and exact requested Project URL were already observed after successful launch/submission.

## Completion decision

M7 core functionality is complete. Live recovery of an M7-created Worker may be rechecked later as an optional regression smoke, but it is not required to close the feature: durable route reuse is covered by automated placement/recovery behavior and the pre-existing Worker recovery contract remains intact.
