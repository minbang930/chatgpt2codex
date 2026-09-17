# M6 Live Validation

Live validation record for **M6 - Worker Execution Configuration** on `dev/custom-runtime`.

Validation environment:

- Windows/VMware dedicated Worker Chrome profile.
- Local test project: `c2c-smoke`.
- Mapped ChatGPT Project route: `https://chatgpt.com/g/g-p-6aab2b62ecc8819190c854618ecffaba/project`.
- Exact live model label observed: `GPT-5.6 Sol`.
- Runtime execution policy under test: explicit settings are fail-closed unless `allow-current` is durably configured.

## Result

M6.5 live validation is complete. The code change discovered during validation is commit `3cb220986a4a9219d239e7638a9184f41cbbc2bf` (`Retry execution picker activation before fail-close`). Final cross-platform CI also completed successfully on post-validation HEAD `5dac24f96bd9ae162ad26a0b29bfeb96883526bd`: GitHub Actions run `35172617811` passed Ubuntu, macOS, and Windows. The M6 milestone is therefore complete.

## No-explicit-setting compatibility

Worker `wrk_cdf9a6c6-b5e4-457d-86b3-aa7d4ad76567` was created without model, reasoning, or fallback overrides.

- `execution.requested`, `resolved`, `sources`, `observed`, `verified`, and `error` remained absent through browser attempts 1 and 2.
- Attempt 1 ended without `worker_finish`, producing the expected recoverable lifecycle error while the durable worker stayed `running`.
- The same durable worker recovered in attempt 2 and completed normally.
- README first heading: `# c2c-smoke`.
- `changedFiles=[]`.

This confirms the pre-M6 unmanaged/current-ChatGPT path remains compatible and execution controls are not touched when no durable execution intent exists.

## Live model/reasoning availability

Confirmed on the current account/profile:

- `GPT-5.6 Sol / instant` -> selectable, observed `instant`, `verified=true`.
- `GPT-5.6 Sol / medium` -> selectable, observed `medium`, `verified=true`.
- `GPT-5.6 Sol / high` -> selectable, observed `high`, `verified=true`.
- `GPT-5.6 Sol / extra-high` -> unavailable in the current account/profile; request fails before worker task submission.

The stable runtime key `extra-high` remains part of the adapter contract. Its unavailability here is an account/profile capability limitation, not a reason to remove or downgrade the runtime key.

Instant confirmation used worker `wrk_eb3df8c0-61ae-49e7-b5da-339be05e1190`, which completed with README `# c2c-smoke`, `changedFiles=[]`, and matching requested/resolved/observed telemetry.

Extra-high boundary confirmation used worker `wrk_e60c90c7-743e-4f74-8082-51ae9384c831`:

- durable status remained `pending`;
- browser failed on attempt 1;
- requested/resolved were `GPT-5.6 Sol / extra-high / fail-closed`;
- observed state was `GPT-5.6 Sol / high`;
- `verified=false`;
- error: `ChatGPT reasoning effort "extra-high" is unavailable in the current account/profile`;
- no worker task was submitted.

## Parallel different-intent workers

Two workers were launched concurrently after the live picker-race fix:

- Worker A `wrk_97b19ddf-86fe-4944-a559-933ed6e7c363`: `GPT-5.6 Sol / medium`, attempt 1, durable `running`, browser `running`, `verified=true`.
- Worker B `wrk_e2e64459-de27-46f6-a112-8cd2092c1e1f`: `GPT-5.6 Sol / high`, attempt 1, durable `running`, browser `running`, `verified=true`.

Both were simultaneously running with distinct durable intents and matching current-attempt observations.

## Picker activation race and fix

Before the fix, parallel Worker B `wrk_a701d5e3-3301-4c78-8c2b-bffc99e4081d` failed its first browser attempt with:

`ChatGPT execution controls did not expose the model/reasoning menu after activation`

The same durable worker/intention succeeded when relaunched alone in attempt 2 with `GPT-5.6 Sol / high`, `verified=true`. Source inspection showed `openExecutionMenu()` retried control hydration but clicked the execution control only once. If that click did not materialize the menu, the adapter polled for two seconds and immediately failed closed.

Commit `3cb220986a4a9219d239e7638a9184f41cbbc2bf` changes this to:

- at most 2 activation attempts;
- 10 menu polls per activation at 100 ms each;
- unchanged total menu-observation budget of 2 seconds;
- fresh execution-control observation before each activation;
- fresh structural menu observation before retry;
- success only when structural `menuOpen=true` is observed; pointer dispatch alone is never success.

Focused validation after the change:

- `npx vitest run src/agents/chrome-execution.test.ts` -> 14/14 passed.
- `npx vitest run src/agents/chrome-cdp-execution.test.ts` -> 2/2 passed.
- `npm run typecheck` -> passed.

The local full `npm test` run still contained unrelated Windows/platform-dependent failures, so it is not recorded as globally green. Cross-platform GitHub Actions run `35172617811` is the authoritative final CI result and passed all supported jobs.

## Target-loss recovery

A live running worker using durable `GPT-5.6 Sol / high / fail-closed` intent had only its browser target removed.

Before recovery:

- durable status: `running`;
- browser: `failed / 1`;
- `recoverable=true`;
- requested/resolved intent still matched `GPT-5.6 Sol / high / fail-closed`;
- attempt-1 observation remained `GPT-5.6 Sol / high`, `verified=true`.

After exactly one same-worker `agent_launch` recovery:

- durable status remained `running`;
- browser became `running / 2`;
- browser handle changed from the attempt-1 handle;
- durable requested/resolved intent was unchanged;
- a fresh attempt-2 observation was persisted as `GPT-5.6 Sol / high`;
- `verified=true`.

This confirms recovery reuses the immutable durable execution intent while replacing attempt-scoped browser telemetry.

## Deliberately unavailable explicit model

Worker `wrk_fca6cfcc-a9c4-437e-be96-eed0d397bc4c` requested:

- model `__c2c_nonexistent_model__`;
- reasoning `high`;
- fallback `fail-closed`.

Observed result:

- durable status `pending`;
- launch failed;
- browser `failed / 1`;
- observed current state `GPT-5.6 Sol / high`;
- `verified=false`;
- error: `ChatGPT model option "__c2c_nonexistent_model__" is unavailable or ambiguous in the current execution picker`;
- worker task was not submitted.

This confirms explicit unavailable model requests fail closed before Worker-app task submission while retaining bounded observed-state diagnostics.

## Mapped ChatGPT Project routing

The mapped route `https://chatgpt.com/g/g-p-6aab2b62ecc8819190c854618ecffaba/project` was exercised by explicit high/medium, parallel, and recovery validation. Successful attempts reported `browserRoute=project` with the expected `projectUrl`.

## Worker `/mcp/worker` isolation

Worker `wrk_2e7e9d22-9166-456e-b1e3-d7fb80bda44c` confirmed the worker catalog contains only:

- `worker_finish`
- `worker_project_rules`
- `worker_project_status`
- `worker_repo_status`
- `worker_repo_diff_summary`
- `worker_code_search`
- `worker_file_read_slice`
- `worker_file_apply_patch`
- `worker_file_create`
- `worker_local_shell_run`
- `worker_git_commit`
- `worker_show_changes`

Main-only `project_select`, Agent Manager, Computer Use, and ordinary project/file/shell/git tools were not present. The opaque worker capability remained scoped to the worker's isolated worktree/branch, while the normal main `/mcp` catalog remained available to the parent.

## M6.5 exit status

All planned M6.5 live-validation items are satisfied:

- [x] no-explicit-setting compatibility;
- [x] explicit model/reasoning verification at multiple levels;
- [x] parallel workers with different durable intents;
- [x] target-loss recovery preserving durable intent with fresh attempt telemetry;
- [x] unavailable explicit preference failing before task submission;
- [x] mapped ChatGPT Project routing;
- [x] Worker `/mcp/worker` catalog/capability isolation and normal main `/mcp` behavior;
- [x] exact live model label and reasoning availability/profile limitation recorded;
- [x] final cross-platform CI green: run `35172617811` on `5dac24f96bd9ae162ad26a0b29bfeb96883526bd`.

M6 is complete.