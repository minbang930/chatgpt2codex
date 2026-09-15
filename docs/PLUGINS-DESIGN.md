# External MCP Plugins Design

This document defines the M5.5 external MCP plugin architecture for `dev/custom-runtime`.

## Goal

Add optional external MCP servers without merging their lifecycle, failures, or tool authority into the stable Core coding runtime.

The intended flow is:

```text
local operator registers endpoint
 -> plugin is disabled by default
 -> local operator explicitly enables it
 -> runtime discovers bounded remote MCP metadata
 -> main agent may call an explicitly selected plugin tool
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

A plugin outage, invalid response, missing credential environment variable, or discovery failure must not prevent `createServer()` from returning or disable normal coding tools.

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
- created/updated timestamps.

The registry is bounded to 16 plugins and 8 configured headers per plugin. Secrets are never written into `plugins.json`.

### Endpoint policy

Version 1 accepts only:

- HTTPS endpoints; or
- plain HTTP endpoints on loopback hosts for local development/services.

Embedded URL credentials, query strings, and URL fragments are rejected. Authentication material must be supplied through environment-backed headers.

### Mutation policy

Remote ChatGPT sessions may inspect plugin state but may not register, remove, enable, disable, or change external endpoints. Plugin mutation is local-only.

This keeps adding a new network authority equivalent to locally arming a capability rather than allowing a remote model session to silently extend its own tool surface.

## M5.5 units

### M5.5.1 - Registry and management foundation

- versioned `plugins.json` registry;
- safe URL/header validation;
- environment-backed credential references only;
- disabled-by-default registration;
- local-only mutation tools;
- read-only `plugin_list` available to normal sessions;
- no network connection occurs while listing/configuring.

Management tools:

```text
plugin_list
plugin_register
plugin_set_enabled
plugin_remove
```

### M5.5.2 - Discovery client

- connect only to enabled plugins;
- resolve environment-backed headers only in memory;
- bounded MCP initialization and `tools/list` discovery;
- timeouts and response-size limits;
- expose connection/discovery status without registering remote tools into Core;
- plugin discovery failure remains per-plugin and fail-isolated.

### M5.5.3 - Explicit invocation proxy

- one fixed Core-side proxy tool for an explicitly selected plugin/tool name;
- bounded arguments/results;
- no dynamic remote tool registration into the main Core server;
- remote plugin errors map to plugin-call failure only;
- browser workers remain denied by default.

### M5.5.4 - Optional plugin skill roots

Plugin-provided skill roots are not implicitly trusted. Any future plugin skill root must be declared explicitly by configuration/manifest and pass through the existing M5.1-M5.4 Skill loader, provenance, path, size, activation, resource, and security boundaries.

## Non-goals

M5.5 does not:

- allow external plugins to mutate the Core tool registry at runtime;
- let a remote ChatGPT session register or enable new plugin endpoints;
- persist plaintext plugin credentials;
- automatically grant plugin tools to browser workers;
- execute plugin-provided local scripts;
- treat plugin-provided skills as trusted merely because the plugin is enabled.
