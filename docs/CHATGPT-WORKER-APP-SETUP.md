# ChatGPT Worker App Setup

Browser workers use a dedicated ChatGPT custom app so their first task message is attached to the worker-only MCP endpoint instead of the main-agent MCP endpoint.

## Required ChatGPT apps

Keep two custom apps connected to the same running chatgpt2codex public origin:

| ChatGPT app | MCP endpoint | Purpose |
| --- | --- | --- |
| `ChatGPT To Codex` | `<public-origin>/mcp` | Main-agent Core tools, including explicitly configured plugin proxies |
| `ChatGPT To Codex Worker` | `<public-origin>/mcp/worker` | Browser-worker `worker_*` tools plus `worker_finish` only |

The worker app name is significant because the browser launcher selects it through ChatGPT's `@` app picker before submitting the worker task. If a different display name is used, set `CHATGPT2CODEX_WORKER_APP_NAME` to that exact app name before starting the runtime.

## Setup

1. Start chatgpt2codex and its ChatGPT web connector normally.
2. Copy the normal connector URL. It ends in `/mcp`.
3. In ChatGPT, keep or create the main custom app using that `/mcp` URL.
4. Create a second custom app named `ChatGPT To Codex Worker`.
5. Give the worker app the same public origin but change the path to `/mcp/worker`.
6. Complete OAuth authorization for the worker app with the same local Owner Token flow.
7. Confirm both apps are available from ChatGPT's `@` app picker in the dedicated worker Chrome profile.

Do not point the worker app at `/mcp`. The `/mcp/worker` resource has a separate OAuth audience and exposes only the worker catalog.

## Runtime behavior

On browser-worker launch, chatgpt2codex:

1. opens the mapped ChatGPT Project or a standalone ChatGPT chat;
2. waits for the composer;
3. types `@ChatGPT To Codex Worker` (or the configured exact name);
4. selects the matching app from ChatGPT's app picker;
5. inserts the worker bootstrap and scoped `workerToken`;
6. submits the message only after app selection succeeds.

If the worker app cannot be found, launch fails closed before the task is submitted. It does not silently fall back to the main `ChatGPT To Codex` app.

The worker app controls the message-level MCP catalog. The existing `workerToken` remains the per-worker repository authority and is still required on every `worker_*` call.

## Live smoke

After the worker app is connected, run a small browser-worker task through the normal `agent_spawn` / `agent_launch` flow. The expected result is:

- the worker message is submitted with `ChatGPT To Codex Worker` selected;
- the worker can call `worker_project_rules` and other allowed `worker_*` tools using its scoped token;
- the worker cannot obtain main-agent plugin, ordinary file/shell/git, Computer Use, Skill, or Agent Manager tools from the worker app;
- completion still arrives through `worker_finish` and the durable worker result flow.

If launch reports that the worker app is missing, open the same dedicated worker Chrome profile, verify the custom app is connected and visible in the `@` picker, then retry. If the app has a different display name, set `CHATGPT2CODEX_WORKER_APP_NAME` to that exact name.

## Security boundary

The separation is layered deliberately:

```text
main ChatGPT message
  -> ChatGPT To Codex
  -> /mcp
  -> main-agent catalog

browser-worker task message
  -> ChatGPT To Codex Worker
  -> /mcp/worker
  -> worker-only catalog
  -> workerToken capability
  -> isolated worker worktree
```

ChatGPT Project placement is only UI organization. It does not grant repository authority and does not replace the worker app, OAuth resource boundary, or worker capability.
