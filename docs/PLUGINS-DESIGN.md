# External MCP Plugins Design

This document defines the M5.5 external MCP plugin architecture for `dev/custom-runtime`.

## Goal

Add optional external MCP servers without merging their lifecycle, failures, or tool authority into the stable Core coding runtime.

The implemented flow is:

```text
local operator registers endpoint
 -> plugin is disabled by default
 -> local operator explicitly enables it
 -> runtime discovers bounded remote MCP metadata on demand
 -> main agent calls one explicitly selected plugin/tool through a fixed proxy
 -> plugin failures stay isolated from Core
```

Browser-worker plugin authority remains disabled. Post-M5 stabilization now adds a separate worker transport/catalog boundary so a worker connection can receive only the capability-scoped `worker_*` surface while the main agent retains its plugin proxies.

## Boundary

External plugins are a separate extension plane:

```text
Core MCP tools
Agent/worker tools
Skills
Hooks
---------------- stable Core boundary
External MCP plugins
```

A plugin outage, invalid response, missing credential environment variable, discovery failure, or invocation failure does not prevent `createServer()` from returning and does not disable normal coding tools.

The main Core tool registry remains fixed. Remote plugin tool schemas are discovered as data and are never dynamically registered as new Core tools.

## Registry

Runtime-owned configuration lives at:

```text
<stateDir>/plugins.json
```

Version 1 entries contain:

- stable plugin id;
- display name;
- enabled/disabled state;
- Streamable HTTP endpoint;
- optional HTTP header names whose values are resolved from environment variables at connection time;
- optional explicitly declared HTTPS Git skill sources;
- created/updated timestamps.

The registry is bounded to 16 plugins, 8 configured headers per plugin, and 8 declared skill sources per plugin. Secrets are never written into `plugins.json`.

### Endpoint policy

Version 1 accepts only:

- HTTPS endpoints; or
- plain HTTP endpoints on loopback hosts for local development/services.

Embedded URL credentials, query strings, and URL fragments are rejected. Authentication material must be supplied through environment-backed headers.

### Mutation policy

Remote ChatGPT sessions may inspect plugin state but may not register, remove, enable, disable, or change external endpoints. Plugin mutation is local-only.

This keeps adding a new network authority equivalent to locally arming a capability rather than allowing a remote model session to silently extend its own tool surface.

## Discovery contract

`plugin_discover` connects only to configured plugins that are enabled. Environment-backed header values are resolved only in memory at connection time.

Discovery is bounded to:

```text
64 tool entries per plugin
1,000 description characters per tool
32,000 serialized schema characters per tool
128,000 serialized schema characters across one discovery result
8 second default discovery timeout
```

Oversized schema material is omitted and marked as truncated. Disabled plugins are reported without network access. Per-plugin connection or protocol failures are returned as isolated discovery reports and do not alter Core registration or runtime availability.

## Invocation contract

`plugin_call` is the only Core-side invocation bridge. It requires an explicit configured plugin id and exact remote tool name.

The proxy:

- rejects missing or disabled plugins;
- resolves configured headers only in memory;
- connects to the selected plugin and verifies the requested tool exists;
- accepts at most 64,000 serialized argument characters;
- bounds returned serialized result data to 128,000 characters, returning a preview when larger;
- uses a 30 second default call timeout;
- closes its MCP client after the operation;
- maps plugin errors to that call only.

Because an arbitrary external MCP tool may mutate remote state, `plugin_call` is conservatively exposed as an open-world, potentially destructive operation. Enabling the plugin is the local operator's network-authority gate; calling a tool still requires the main agent to select that plugin/tool explicitly.

## Worker transport boundary

The worker capability path remains narrow:

- `registerWorkerTools()` creates only `worker_*` mirrors derived from the explicit `WORKER_CORE_TOOL_NAMES` allowlist;
- no `worker_plugin_call`, `worker_plugin_discover`, or other `worker_plugin_*` surface is registered;
- `dispatchWorkerCoreTool()` checks the same allowlist before capability verification and rejects `plugin_list`, `plugin_discover`, `plugin_call`, and every other non-allowlisted Core tool;
- adding or enabling plugin configuration does not widen this worker-prefixed capability surface.

Post-M5 stabilization adds a second remote resource in the same server process:

```text
main ChatGPT connector   -> /mcp        -> createServer()       -> normal main-agent catalog
browser-worker connector -> /mcp/worker -> createWorkerServer() -> worker_* + worker_finish only
```

`createWorkerServer()` reuses the existing Core registrations only long enough to obtain the schemas/handlers needed by `registerWorkerTools()`, then reduces its public MCP registry to exactly `worker_finish` plus the `worker_*` mirrors derived from `WORKER_CORE_TOOL_NAMES`. Plugin, Skill, Computer Use, Agent Manager, and unprefixed file/shell/git tools therefore do not enter the worker transport's `tools/list` or `tools/call` surface.

The worker resource reuses the existing single OAuth provider rather than introducing a second credential store. The provider remains rooted at `/mcp`, and `/mcp/worker` is an OAuth child resource. The HTTP transport then applies a stricter boundary:

- path-specific protected-resource metadata advertises `/mcp/worker`;
- `/mcp` accepts only an access token whose OAuth resource is exactly `/mcp`;
- `/mcp/worker` accepts only an access token whose OAuth resource is exactly `/mcp/worker`;
- tracked Streamable HTTP sessions carry a `main` or `worker` role and cannot be replayed through the opposite route.

The exact audience check is intentional. The MCP SDK's normal resource helper permits descendant paths, so relying on prefix matching alone would let a `/mcp/worker` token satisfy the broader `/mcp` resource. The route-level exact comparison closes that escalation path while preserving one authorization server/store.

This transport boundary does **not** replace the durable worker capability. A browser worker still needs its opaque `workerToken` on each `worker_*`/`worker_finish` call, and the dispatcher still resolves that token to the durable worker/worktree before executing an allowlisted Core operation. The endpoint narrows the catalog; the worker capability remains the authority for a particular worker.

Regression coverage lives in:

- `src/plugins/worker-isolation.integration.test.ts` for configured-plugin versus worker-capability/catalog behavior;
- `src/server/worker-mcp-isolation.test.ts` for real OAuth authorization-code + PKCE, real Streamable HTTP MCP clients, main/worker `tools/list`, plugin-call denial, protected-resource metadata, and cross-audience token rejection.

### ChatGPT-side routing requirement

The server-side boundary is only effective for a browser-worker conversation that actually connects to `/mcp/worker`. A ChatGPT conversation still connected to `/mcp` is intentionally treated as a main-agent remote session and receives the main catalog.

The current Chrome/CDP bootstrap can submit the worker task and capability but cannot securely change which installed ChatGPT MCP connector/app a conversation uses merely through prompt text. Therefore the remaining stabilization work is to provision/select/validate a ChatGPT-side worker connector or Project/app context that points to `/mcp/worker`, while the normal main conversation remains on `/mcp`.

Do not replace that integration step with timing heuristics, "next session is worker" state, or first-call role inference: each of those exposes the main catalog before trusted worker identity is established. Likewise, do not globally hide main-agent plugin proxies while a worker exists. Main-agent plugin access must remain independent.

Any future worker plugin access would require a separate reviewed allowlist/capability contract; it is not part of this boundary.

## Optional plugin skill sources

A plugin may declare up to eight optional skill sources in local configuration:

```text
id
source     HTTPS Git URL
ref        optional
skillName  optional
```

These declarations are inert metadata. They do not install, activate, scan, or inject a skill automatically, and the plugin endpoint cannot add them dynamically to Core state.

To use a declared source, the normal `skill_install` path is used. That keeps plugin-associated skills behind the existing M5.1-M5.4 boundaries: managed snapshot export, provenance, path/size limits, external-source security scanning, explicit activation, bounded resources, and disabled executable scripts.

## M5.5 units

### M5.5.1 - Registry and management foundation — complete

- versioned `plugins.json` registry;
- safe URL/header validation;
- environment-backed credential references only;
- disabled-by-default registration;
- local-only mutation tools;
- read-only `plugin_list` available to normal sessions;
- no network connection while listing/configuring.

Management tools:

```text
plugin_list
plugin_register
plugin_set_enabled
plugin_remove
```

### M5.5.2 - Discovery client — complete

- enabled-only Streamable HTTP connection;
- in-memory environment-header resolution;
- bounded MCP initialization and `tools/list` metadata;
- timeout/schema/catalog limits;
- fixed `plugin_discover` Core tool;
- per-plugin failure isolation.

### M5.5.3 - Explicit invocation proxy — complete

- fixed `plugin_call` Core tool;
- explicit plugin id + tool name;
- bounded arguments/results;
- remote tool existence validation;
- no dynamic remote tool registration;
- per-call failure isolation;
- no worker-prefixed plugin proxy is registered.

### M5.5.4 - Optional plugin skill sources — complete

- explicit local configuration declarations only;
- HTTPS Git sources only;
- no automatic install/activation;
- normal `skill_install` remains the only installation path;
- existing Skill provenance/security boundaries remain authoritative.

## Non-goals

M5.5 does not:

- allow external plugins to mutate the Core tool registry at runtime;
- let a remote ChatGPT session register or enable new plugin endpoints;
- persist plaintext plugin credentials;
- add plugin tools to `WORKER_CORE_TOOL_NAMES` or create a `worker_plugin_*` proxy;
- execute plugin-provided local scripts;
- automatically install or activate plugin-declared skills;
- treat plugin-provided skills as trusted merely because the plugin is enabled.

Automatic ChatGPT-side provisioning/selection of the `/mcp/worker` connector remains a post-M5 stabilization integration concern rather than an M5.5 plugin property.