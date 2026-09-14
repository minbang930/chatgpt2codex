# Custom Runtime Progress

Implementation status for `dev/custom-runtime`.

## Current status

Overall phase: **M2 - ChatGPT Web workers**

Active unit: **M2.3 - ChatGPT worker launch/bootstrap**

## Completed

### M0 - Baseline

- [x] Fork: `minbang930/chatgpt2codex`
- [x] Development branch: `dev/custom-runtime`
- [x] Confirmed fork baseline matches upstream starting point.
- [x] Added CI baseline.
- [x] Cross-platform typecheck/build on Ubuntu and Windows.
- [x] Full test suite + build on macOS.
- [x] Preserved original runtime behavior while adapting CI to existing platform-specific tests.

Relevant commits:

- `bac50959017aef61eac9625778cc97d8597a15d5` - initial baseline CI
- `53c2d1a4cb531f6bf8338936b58e0b07b391b45f` - split CI by platform capabilities

### M1.1 - Durable worker state and inbox

- [x] Added `src/agents/store.ts`.
- [x] Worker states: `pending`, `running`, `completed`, `failed`, `cancelled`.
- [x] Atomic worker JSON persistence under runtime state.
- [x] Completion/failure/cancellation event persisted with final state.
- [x] Durable result remains available after notification is marked delivered.
- [x] Idempotent repeat completion does not create duplicate events.
- [x] Invalid/traversal worker and event IDs are rejected.
- [x] Final workers cannot transition back to running or to another final state.
- [x] Unit tests added.
- [x] CI green on Ubuntu, Windows, and macOS after implementation.

Relevant commits:

- `8de81ae3b9c8a3c2f0868d0bb0375b28881d5f2e` - durable worker state and completion inbox
- `072feace2ed4359dd52d13ced2159ce0409146aa` - worker store tests

### M1.2 - Worker-specific Git worktree isolation

- [x] Create one branch per worker.
- [x] Create one worktree per worker.
- [x] Keep worker worktrees under runtime-managed state, not inside the user's main checkout.
- [x] Persist worker branch/worktree assignment in the worker record.
- [x] Verify the worktree points at the intended repository and base commit.
- [x] Make creation safe/idempotent enough for retries.
- [x] Refuse arbitrary worker/worktree paths.
- [x] Add cleanup primitives without deleting work by default.
- [x] Add real-Git integration tests.
- [x] Pass final CI verification on Ubuntu, Windows, and macOS.

Implementation notes:

- `6795635d6d70f4cc59216301b397954746110dae` added managed worker worktrees, persisted workspace metadata, safe cleanup, and real-Git tests.
- The first macOS run exposed the `/var/...` vs `/private/var/...` alias returned by `realpath`/Git worktree metadata. The runtime correctly refused the mismatch rather than guessing.
- `84d34d46fffdd657c6dc8b02ed1b15668b4a49d1` canonicalizes existing managed paths before comparison so the same physical worktree is recognized without weakening path confinement.
- CI run `34807866538` passed all jobs: Ubuntu agent tests/typecheck/build, Windows agent tests/typecheck/build, and macOS full test/typecheck/build.
- Worker cleanup intentionally omits `git worktree remove --force`, so dirty/untracked work is preserved and cleanup fails safely. The worker branch is preserved after a clean worktree removal.

### M1.3 - Agent Manager API

- [x] Spawn a durable worker record and provision its isolated workspace.
- [x] Keep newly provisioned workers `pending` until a real browser worker accepts the task.
- [x] Status retrieval.
- [x] Result retrieval for pending/running/completed/failed/cancelled workers.
- [x] Cancellation without deleting partial worker work or removing the worktree.
- [x] Verified worker-workspace lookup for future worker-scoped tool routing.
- [x] Short event wait over the durable completion inbox.
- [x] Event wait does not acknowledge delivery automatically.
- [x] Explicit event acknowledgement after successful delivery.
- [x] Bound event waits to 0-60 seconds.
- [x] Integration tests across real Git repositories/worktrees.
- [x] Pass CI verification on Ubuntu, Windows, and macOS.

Implementation notes:

- `d680dca3da4016fd219ffbb49db85a938c36e1b3` added `src/agents/manager.ts` with spawn/status/result/cancel/workspace/wait/ack orchestration.
- `b904a1450ceabb30ae39047357af2a1b8ad783bb` added lifecycle and event-wait integration tests.
- Spawn intentionally leaves workers `pending`; M2 browser-worker startup will own the transition to `running`.
- If workspace provisioning fails after the durable worker record is created, the record is preserved and the thrown domain error includes the `workerId`. This avoids deleting an uncertain worktree/branch and keeps recovery possible.
- `agent_wait` semantics are prepared as a short inbox wait, while full worker output remains the responsibility of result retrieval.
- CI run `34808287371` completed successfully across Ubuntu, Windows, and macOS.

### M1.4 - MCP agent tools

- [x] `agent_spawn`
- [x] `agent_status`
- [x] `agent_result`
- [x] `agent_wait`
- [x] `agent_cancel`
- [x] `worker_finish`
- [x] Agent tool metadata is visible through the existing ChatGPT MCP `tools/list` path.
- [x] `agent_spawn` requires an active full-write-capable project lease.
- [x] `agent_spawn` currently reports `prepared` rather than pretending a browser worker is already running.
- [x] `worker_finish` verifies the managed worktree and validates an optional commit SHA against worker HEAD.
- [x] `agent_wait` consumes only concise completion events; full output remains durable behind `agent_result`.
- [x] Cross-platform CI explicitly runs the agent MCP test surface on Ubuntu and Windows; macOS runs the full suite.

Implementation notes:

- `88b981cbfe89deeb79dd72c33ccc20b75e3a981f` added the separate `src/server/agent-tools.ts` MCP surface so the large existing Core tool implementation did not need invasive edits.
- `99a61874284d726edfeef9bf12c477f92aa63d67` registered the custom-runtime agent tools for both stdio and HTTP MCP server construction.
- `3052774e908df62cbacff463c31be8d1d98d8479` added MCP lifecycle, tools/list, lease, finish/wait/result, and cancellation coverage.
- Initial CI caught unsupported top-level `securitySchemes` in the SDK's typed `registerTool` config. `dfdf9d3b06358e76cde528f1be1b9404dd2be4dd` aligned the registration with the existing runtime pattern by keeping the OAuth declaration in ChatGPT metadata; the existing `tools/list` adapter still supplies the public top-level security scheme.
- `02b846ee0d0bc528aecfc35c5db1567ad5c7ed81` extended Ubuntu/Windows CI to run `src/server/agent-tools.test.ts` together with `src/agents` tests.
- CI run `34808660734` passed on Ubuntu, Windows, and macOS.

### M1.5 - Completion notification piggyback

- [x] Attach concise final-worker notices to subsequent normal Core MCP results.
- [x] Keep full worker output out of piggyback payloads and durable behind `agent_result`.
- [x] Deliver at most five notices per Core result; excess events remain pending for a later call.
- [x] Mark only attached events notified while retaining the worker result.
- [x] Do not let explicit `agent_*` calls accidentally consume Core piggyback notices.
- [x] Treat inbox/piggyback failures as best-effort so they cannot break otherwise-successful Core tool execution.
- [x] Add cross-platform tests for one-time delivery, bounded batches, and result durability.
- [x] Pass CI verification on Ubuntu, Windows, and macOS.

Implementation notes:

- `f3b9c80bd254ea0c8dbaf9a8641e928da8082964` added `src/agents/piggyback.ts`.
- `b0f92638d8f8168bab1149678814664d6d5903bc` installs the wrapper after Core tool registration and before agent tool registration, keeping the existing large Core implementation untouched.
- `30cb2921b1c3826fb2f5e111dc291dc63601e310` added piggyback tests proving notification delivery does not discard the full worker result.
- `83b6ee2a6cdbe83a31a66e8ab92ef17bfc8cec95` extends Ubuntu/Windows CI to run the piggyback tests too.
- CI run `34808933047` passed all jobs on Ubuntu, Windows, and macOS.

### M2.1 - Worker-scoped Core routing

- [x] Issue/verify/revoke opaque worker capabilities without persisting raw tokens.
- [x] Resolve every worker call to the durable worker assignment and managed worktree.
- [x] Build a worker-specific in-memory `ToolContext` with a full-write lease rooted at that worktree.
- [x] Reuse existing Core handlers through an explicit worker allowlist rather than duplicating file/shell/git safety logic.
- [x] Keep worker tool calls from mutating the main ChatGPT `sessions.json` active project/lease.
- [x] Expose explicit worker-scoped Core tools rather than one generic unrestricted dispatch tool.
- [x] Require the worker capability for the `worker_finish` completion handshake.
- [x] Add isolation/capability tests and pass CI on Ubuntu, Windows, and macOS.

Implementation notes:

- `0a47070e4b96ed06a9f113f427685789b2382f95` added worker capability lifecycle.
- `3d5886a88d580704637d2ba3f82cfeed96c6063b` added the worker-scoped Core dispatcher.
- `a75814070d07f5abb3b1191dfb5ec65b8aa1afaf` verifies worker Core calls do not mutate main session state.
- `66159afac1769825e866d8a52b252018524eadc5` exposes the explicit worker Core tool surface.
- `83166838aa034bce68d239ac34ddca977c833448` changes `worker_finish` to capability authorization.
- `6b352ed7a4921f898639bffee719ae4591f03e54` registers worker-scoped tools with Core MCP construction.
- `0140853b23a3b049457b4a3e6abaec03b7e874e3` completes capability-authorized finish coverage.
- CI run `34809750569` passed on Ubuntu, Windows, and macOS.

### M2.2 - Browser worker controller foundation

- [x] Add optional local-project -> ChatGPT Project routing state.
- [x] Restrict mapped destinations to HTTPS `chatgpt.com` URLs.
- [x] Resolve unmapped repositories to a standalone-chat route.
- [x] Define durable browser-worker state separately from ChatGPT private conversation/request identity.
- [x] Define `BrowserWorkerDriver` launch/cancel boundary without choosing a browser automation implementation yet.
- [x] Keep browser handles advisory/local only; they do not authorize worker tools.
- [x] Never persist the raw worker capability or task in browser-session state.
- [x] Record browser launch failure independently while leaving the durable coding worker pending for retry.
- [x] Support a fresh browser attempt after failure.
- [x] Keep browser cancellation separate from durable worker/worktree cancellation.
- [x] Add cross-platform controller/routing tests before connecting to a real ChatGPT tab.
- [x] Pass CI on Ubuntu, Windows, and macOS.

Implementation notes:

- `e4ee5b3934f437c22412cf91903b34a6bfb045eb` documents ChatGPT Project worker routing.
- `2448e60c9b83725a8b011e37ece9ffe42fc187cc` adds browser session/routing/controller foundations.
- `33ea1bff844e5390953e575c3d0dfcce0a9c4f89` binds browser sessions to an existing durable worker/project assignment.
- `15fa47aafba6bce51b1e76cdd25b45a59203317d` adds routing, secret-nonpersistence, failure-isolation, retry, and cancel tests.
- CI run `34812803678` passed on Ubuntu, Windows, and macOS.

## In progress

### M2.3 - ChatGPT worker launch/bootstrap

- [ ] Choose the smallest reliable browser automation path for the existing authenticated ChatGPT session.
- [ ] Open a dedicated worker chat, preferably inside the mapped ChatGPT Project.
- [ ] Fall back to a standalone worker chat when no mapping exists or mapped-Project navigation is unavailable.
- [ ] Send worker bootstrap + task without persisting the raw capability in browser-session state.
- [ ] Hand off the opaque worker capability to the worker chat.
- [ ] Transition the durable coding worker `pending -> running` only after launch/bootstrap succeeds.
- [ ] Keep browser launch failure retryable without damaging the worktree.
- [ ] Add integration tests around the browser driver boundary before relying on live UI behavior.

## Planned next

### M2.4 - Worker completion/recovery

- [ ] `worker_finish` remains the primary completion handshake.
- [ ] DOM completion detection is fallback only.
- [ ] Browser close/failure/cancellation recovery.
- [ ] Parallel worker lifecycle tests.

### M3 - Windows Computer Use

- [ ] Windows-native desktop control for the VMware environment.

### M4 - Hooks

- [ ] Hook engine.
- [ ] `SessionStart`.
- [ ] `PreToolUse` / `PostToolUse`.
- [ ] `SubagentStart` / `SubagentStop`.
- [ ] Ponytail-style integration after semantics stabilize.

### M5 - Plugins

- [ ] Separate optional Plugins connector.
- [ ] External MCP discovery/configuration.
- [ ] Failure isolation from Core.

## Known baseline notes

The original test suite contains desktop-control tests whose behavior is platform-specific. Running the complete suite on Ubuntu/Windows produces failures unrelated to custom-runtime changes, including macOS-only synthetic input/accessibility expectations. CI therefore uses:

```text
Ubuntu:   typecheck + agent/MCP-agent/piggyback tests + build
Windows:  typecheck + agent/MCP-agent/piggyback tests + build
macOS:    typecheck + full test + build
```

All files under `src/agents` are included in the Ubuntu/Windows agent test step, so browser-controller foundation tests run cross-platform even before a real browser driver is connected.

This baseline characteristic is not a custom-runtime regression.

## Update policy

Update this file whenever a unit is completed, blocked, materially redesigned, or moved in scope. Record the verification result and relevant commit(s) before beginning the next implementation unit.
