# Hook Engine Design

This document defines the M4 lifecycle-hook contract for the `dev/custom-runtime` fork.

## Goal

Add a small local lifecycle hook engine without coupling Core correctness to hook availability or success.

Hooks are an optional extension point for local automation and later Ponytail-style behavior. They are not an authorization layer and must not weaken the existing project, lease, command, worker, or Computer Use safety boundaries.

## M4 delivery order

M4 is intentionally split into small units:

1. **M4.1 - Hook engine foundation**
   - versioned configuration
   - command-hook runner
   - timeout/output bounds
   - safe failure isolation
   - unit coverage
2. **M4.2 - `SessionStart` integration**
3. **M4.3 - `PreToolUse` / `PostToolUse` integration**
4. **M4.4 - `SubagentStart` / `SubagentStop` integration**
5. **M4.5 - Ponytail-style integration after the lifecycle semantics are stable**

M4.1 defines all event names up front, but it does **not** yet emit them from the runtime. Wiring begins in M4.2.

## Supported lifecycle events

```text
SessionStart
PreToolUse
PostToolUse
SubagentStart
SubagentStop
```

The event vocabulary is deliberately small. Additional events should be added only when a concrete workflow requires them.

## Configuration ownership

Hook configuration is read only from the runtime-owned state directory:

```text
<stateDir>/hooks.json
```

Repository-controlled files are **not** automatically treated as executable hook configuration. In particular, the engine does not auto-load `.chatgpt2codex/hooks.json`, `AGENTS.md`, package scripts, or similar project files as hooks.

This separation prevents opening an arbitrary repository from silently registering local commands that execute outside the normal coding-tool policy path.

The configuration is versioned so later schema changes can be explicit rather than inferred:

```json
{
  "version": 1,
  "hooks": {
    "SessionStart": [
      {
        "id": "example-session-note",
        "type": "command",
        "command": "node",
        "args": ["C:/Dev/local-hooks/session-start.mjs"],
        "cwd": "workspace",
        "timeoutMs": 5000,
        "enabled": true
      }
    ]
  }
}
```

Limits in M4.1:

- configuration size: 256 KiB
- hooks per event: 20
- default timeout: 5 seconds
- maximum timeout: 30 seconds
- captured stdout/stderr: bounded to 16 KiB per stream buffer budget

## Command-hook execution contract

M4.1 supports one hook driver:

```text
type = command
```

A command hook is launched directly with an argv array. The engine does not invoke a shell and does not accept a shell command string to be interpreted by `cmd.exe`, PowerShell, `/bin/sh`, or another shell.

The child receives the same restricted environment policy used by the existing command runner through `buildSafeChildEnv()`.

The event is delivered as one JSON object on stdin:

```json
{
  "version": 1,
  "event": "PreToolUse",
  "hookId": "example",
  "occurredAt": "2026-09-15T00:00:00.000Z",
  "payload": {
    "toolName": "file_read_slice"
  }
}
```

Hook programs should treat stdin as the event source instead of expecting event data in command-line arguments or environment variables.

## Working directory

Each hook may select one of three bounded working-directory modes:

```text
project
workspace
state
```

- `project`: the active project root supplied by the event integration. If no project exists for the event, it falls back to the workspace root.
- `workspace`: the runtime workspace root.
- `state`: the runtime-owned state directory.

A hook cannot provide an arbitrary `cwd` path through configuration.

## Ordering and failure semantics

Hooks for one event execute sequentially in configuration order in M4.1. This keeps event behavior deterministic and avoids command-hook races while the contract is still new.

Failures are isolated:

- invalid/missing configuration never breaks Core startup or a tool call
- spawn failure is recorded as a failed hook
- non-zero exit is recorded as a failed hook
- timeout is recorded as `timed_out` and the child process tree is terminated best-effort
- a failed hook does not prevent later hooks for the same event from running
- hook stdout/stderr is bounded before being retained in the dispatch report

The default M4 contract is **observational/best-effort**. A hook result does not grant permission and does not veto a Core operation. If a future pre-tool policy hook needs explicit allow/deny semantics, that must be introduced as a separate reviewed contract rather than inferred from process exit codes.

## Security boundaries

The hook engine must preserve these invariants:

- no repository file becomes executable merely because the repository was opened
- no shell interpolation for command hooks
- no secrets copied wholesale into the hook environment
- no hook failure changes the result of an otherwise healthy Core operation
- no hook becomes a substitute for leases, approvals, worker capabilities, or Computer Use policy
- event payloads should contain only the minimum metadata needed by the integration

## Future hook drivers

MCP/local-handler hook kinds may be useful later, but they are intentionally deferred. Maintaining a single direct-command driver first keeps M4.1 small enough to verify thoroughly.

## Integration plan

### M4.2 - SessionStart

Create one engine per runtime context and emit `SessionStart` after the session/runtime context is ready. The hook remains best-effort; startup must continue when the hook config or hook process fails.

### M4.3 - Tool lifecycle

Wrap the existing MCP tool boundary rather than modifying every tool implementation independently:

```text
request
 -> PreToolUse
 -> existing tool handler
 -> PostToolUse
 -> response
```

Payloads should use bounded metadata such as tool name, project identity, success/error state, and duration. Raw secrets and unrestricted tool arguments should not be copied into hook payloads by default.

### M4.4 - Subagent lifecycle

Emit `SubagentStart` only when a durable browser worker actually transitions into its accepted/running lifecycle, and `SubagentStop` once when it reaches or is forced into a terminal/retired state. Hook emission must not become the durable source of truth for worker state.

### M4.5 - Ponytail-style behavior

Ponytail-specific policy or convenience behavior is added only after the generic event timing, payloads, timeout behavior, and failure isolation have been verified independently.
