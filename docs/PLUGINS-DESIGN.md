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

Browser workers do not inherit plugin tools automatically.

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

## Worker boundary

Worker tools remain generated from the explicit `WORKER_CORE_TOOL_NAMES` allowlist. Plugin registration occurs outside that worker mirror path, and no `worker_plugin_call` surface exists.

Therefore browser workers do not automatically inherit:

- `plugin_register`;
- `plugin_set_enabled`;
- `plugin_remove`;
- `plugin_discover`;
- `plugin_call`;
- any remotely discovered plugin tool.

Any future worker plugin access requires a separate reviewed allowlist/capability contract.

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
- browser workers remain denied by default.

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
- automatically grant plugin tools to browser workers;
- execute plugin-provided local scripts;
- automatically install or activate plugin-declared skills;
- treat plugin-provided skills as trusted merely because the plugin is enabled.
