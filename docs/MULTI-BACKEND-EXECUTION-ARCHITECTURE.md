# Multi-Backend Project Execution Architecture

Status: **design accepted / documentation-first / no implementation yet**

This document defines the next architecture direction for `dev/custom-runtime` after the existing Worker, Computer Use, Skills, Plugins, and worker-placement work.

The goal is broader than "give normal Chat local file tools". The desired product is one continuous development session in ChatGPT that can move between GitHub and multiple local machines without forcing the user to restate where the work is happening.

## 1. Why this exists

The original practical motivation for ChatGPT2Codex was to keep coding after local Codex quota was exhausted by using ChatGPT Web as the reasoning surface and ChatGPT2Codex as the local execution runtime.

In practice there are now two useful execution styles:

1. **GitHub-backed remote work**
   - works without a local PC;
   - works while the development PC is powered off;
   - requires little setup beyond repository access;
   - is stable and convenient for repository edits, commits, PRs, and review;
   - cannot run the user's real desktop applications, local-only tests, VMware UI, or Computer Use.

2. **Local ChatGPT2Codex work**
   - can read/write the real checkout;
   - can run local builds/tests;
   - can use Computer Use;
   - can launch isolated browser workers;
   - can interact with machine-specific tools and state;
   - requires the target machine/runtime to be online and connected.

Neither replaces the other. The architecture should therefore treat them as complementary execution backends rather than force one path to imitate the other.

Codex and Claude Code are also expected to remain in use. They are not competing project models; they are additional agents that may operate on a local workspace.

## 2. Product-level goal

Use a **ChatGPT Project as the persistent development session** and allow the same conversation/project to select or automatically resolve an execution environment.

Conceptually:

```text
                         ChatGPT Project / Chat
                    persistent intent and conversation
                                  |
                                  v
                         Execution Resolver
                                  |
               +------------------+------------------+
               |                  |                  |
               v                  v                  v
          GitHub remote       MAIN-PC local      VMware local
               |                  |                  |
          GitHub tools      ChatGPT2Codex       ChatGPT2Codex
                                  |
                         +--------+--------+
                         |        |        |
                      ChatGPT   Codex   Claude Code
```

The conversation is continuous. The execution location is replaceable.

## 3. Core design principle: separate six concepts

Do not overload the current local `Project.root` with every new meaning.

The new architecture separates:

```text
Project
Backend
Machine
Workspace
Agent
State
```

### 3.1 Project

Logical shared development context.

Examples:

- ChatGPT Project ID / URL;
- project name;
- associated GitHub repository;
- project-level execution preferences.

A Project is not inherently tied to one filesystem path.

### 3.2 Backend

Where actions execute.

Initial backend kinds:

```text
github
local
```

Possible future kinds may include a remote-host backend, but this is not required for the first implementation.

### 3.3 Machine

A stable identity for the machine hosting a local runtime.

Examples:

```text
MAIN-PC
VMWARE-DEV
LAPTOP
```

Machine identity must be runtime-owned and should not depend only on the current filesystem path.

### 3.4 Workspace

The concrete code location used by a backend.

Examples:

```text
github:
  repo   = owner/chatgpt2codex
  branch = dev/custom-runtime

MAIN-PC:
  root   = C:\Dev\chatgpt2codex

VMWARE-DEV:
  root   = C:\Dev\chatgpt2codex
```

The same logical ChatGPT Project may map to different absolute local paths on different machines.

### 3.5 Agent

Who is doing the work.

Initial agent identities:

```text
chatgpt-chat
codex
claude-code
worker
```

Backend and Agent are deliberately independent.

Valid examples:

```text
local + chatgpt-chat
local + codex
local + claude-code
local + worker
github + chatgpt-chat
```

This prevents future architecture from incorrectly treating "Codex", "Claude Code", and "local machine" as equivalent concepts.

### 3.6 State

Current observable workspace state needed for safe switching.

At minimum:

- branch;
- HEAD;
- clean/dirty;
- modified-file count or bounded summary;
- ahead/behind relative to known upstream when available;
- current execution target;
- previous execution target;
- capability set.

State is not the code source of truth by itself. It is information used to decide whether a transition is safe.

## 4. Sources of truth

The design uses three different sources of truth for three different jobs.

```text
ChatGPT Project
  = conversation, intent, project instructions, shared context

GitHub repository
  = shareable/persisted code state between machines

Local workspace
  = the real executable working copy on the current machine
```

This distinction is essential.

A ChatGPT conversation may know what was intended on MAIN-PC, but VMWARE-DEV cannot see an uncommitted file that exists only on MAIN-PC.

Machine identification solves "where am I?". It does **not** solve workspace synchronization.

## 5. Machine-specific Project bindings

The required mapping is:

```text
(Project, Machine) -> Local Workspace
```

not:

```text
Project -> one absolute path
```

Example:

```json
{
  "project": "g-p-example",
  "repository": {
    "provider": "github",
    "repo": "owner/chatgpt2codex"
  },
  "bindings": {
    "MAIN-PC": {
      "backend": "local",
      "root": "C:\\Dev\\chatgpt2codex"
    },
    "VMWARE-DEV": {
      "backend": "local",
      "root": "D:\\Repos\\chatgpt2codex"
    }
  }
}
```

Absolute paths should remain machine-local configuration. They should not need to be stored in ChatGPT Project cloud state.

## 6. General Chat as the controller

The preferred UX is that normal ChatGPT Chat remains the user-facing reasoning surface.

Normal Chat should be able to use:

- GitHub when no local runtime is needed or available;
- local MCP tools when a local workspace is selected;
- Computer Use when the selected local profile permits it;
- workers when parallel execution is useful.

The local MCP path is therefore a **backend adapter**, not the definition of the project.

### 6.1 Local tool capabilities

A local execution context may expose capabilities such as:

```text
files
shell
git
computer-use
worker
```

The exact set is derived from policy/lease/runtime availability rather than implied merely by `backend=local`.

## 7. GitHub remains a first-class backend

GitHub must not be demoted to a synchronization implementation detail.

It remains useful precisely because it:

- works when all local development PCs are off;
- works from environments where ChatGPT2Codex is not installed;
- avoids machine-specific setup;
- provides a durable shared repository surface;
- allows work to continue when local runtime access is unavailable.

Therefore the target UI and resolver should make GitHub an explicit execution choice alongside local machines.

## 8. Automatic execution selection

The UI should support an explicit execution target plus an `Auto` mode.

Example:

```text
Execution
  Auto
  GitHub
  MAIN-PC
  VMWARE-DEV
```

A reasonable initial Auto policy is:

```text
ChatGPT Windows on MAIN-PC + mapped local workspace
    -> MAIN-PC local

ChatGPT Windows in VMware + mapped local workspace
    -> VMWARE-DEV local

Web session with no usable local runtime
    -> GitHub

explicit user override
    -> selected backend/machine
```

The resolver must report why it selected a target. Silent fallback between materially different code states is unsafe.

## 9. Automatic execution-context identification

When the same chat is continued on another machine, the user should not need to write:

> I am now on VMware. Continue using the VMware checkout.

The system should identify the current execution context automatically.

Conceptually, the model receives runtime metadata similar to:

```text
<execution-context>
project = chatgpt2codex
backend = local
machine = VMWARE-DEV
workspace = C:\Dev\chatgpt2codex
agent = chatgpt-chat
branch = dev/custom-runtime
capabilities = files,shell,git,computer-use,worker
</execution-context>
```

This metadata is system/runtime context, not text the user has to type manually.

### 9.1 Context-change events

Repeatedly injecting a large block on every user message is unnecessary.

Prefer a compact current-context representation and an explicit change event when the target changes:

```text
<execution-context-change>
previous = MAIN-PC / local / chatgpt-chat
current  = VMWARE-DEV / local / chatgpt-chat
</execution-context-change>
```

The implementation may still attach a small machine/backend tag on every turn for robustness, but the UI should avoid visually polluting the user's message.

### 9.2 UI representation

A small badge is preferred over rewriting the visible message.

Example:

```text
You                                    MAIN-PC · Local
------------------------------------------------------
Run the build and test the change we just made.
```

## 10. Workspace continuity and switching safety

There are three important transition states.

### 10.1 Clean and shared

```text
MAIN-PC HEAD = abc123
working tree = clean
GitHub HEAD  = abc123
```

Safe to continue elsewhere immediately.

### 10.2 Local commits not pushed

```text
MAIN-PC HEAD = def456
GitHub HEAD  = abc123
working tree = clean
```

Another backend cannot see the new commit yet.

### 10.3 Dirty working tree

```text
MAIN-PC
  README.md modified
  src/foo.ts modified
```

Those changes exist only on that machine/worktree.

When switching away from a target with non-shared state, the router should surface the condition instead of pretending continuity exists.

Possible UX:

```text
Current local changes are not present on GitHub.

[Push / publish changes]
[Continue using GitHub version]
[Cancel]
```

The first implementation does not need to automatically commit/push everything.

## 11. Handoff checkpoints

A later phase may add an explicit handoff operation:

```text
MAIN-PC
  -> create/publish handoff checkpoint
  -> GitHub/shareable state
  -> VMWARE-DEV
  -> resume
```

This must remain explicit when it changes repository history or publishes local changes.

It is separate from normal Chat conversation continuity.

## 12. Codex and Claude Code coexistence

Codex and Claude Code remain valid local agents.

The primary correctness concern is not the model vendor. It is simultaneous mutation of the same working tree.

Avoid:

```text
ChatGPT MCP -> C:\Dev\project
Claude Code -> C:\Dev\project
Codex       -> C:\Dev\project
```

all editing concurrently without coordination.

Prefer either explicit ownership or isolated Git worktrees where parallel mutation is intended:

```text
main workspace
C:\Dev\project

Codex worktree
C:\Dev\worktrees\codex

Claude worktree
C:\Dev\worktrees\claude

ChatGPT worker worktree
<stateDir>\agents\worktrees\...
```

The existing worker worktree isolation remains authoritative for ChatGPT2Codex workers.

## 13. Relation to existing ChatGPT2Codex architecture

This design is an extension above the existing Core.

Do not break:

- current project registry;
- `project_select` and lease semantics;
- worker-specific in-memory ToolContext isolation;
- Worker `/mcp/worker` transport/catalog boundary;
- Computer Use control lease, policy, audit, and kill switch;
- existing local file/shell/git safety rules.

The current local `Project.root` remains supported during migration.

The new model should be added as a separate execution/profile layer first.

Conceptually:

```text
existing Project/root + sessions
          |
          v
ExecutionProfile / ExecutionContext
          |
          +-- github target
          +-- machine-local target
          +-- agent selection
          +-- transition state
```

## 14. Persistence direction

Prefer a separate versioned state document initially.

Example:

```text
<stateDir>/
  projects.json
  sessions.json
  execution.json     # new
```

Proposed `execution.json` responsibilities:

- ChatGPT Project identifier/route association;
- repository association;
- local machine bindings;
- backend preferences;
- last target metadata;
- optional project-level Auto preference.

Machine-local secrets, tokens, or unsafe credentials do not belong in this file.

Do not immediately migrate or remove `Project.root`.

## 15. Proposed normalized runtime context

A resolver should eventually produce one internal structure similar to:

```text
ExecutionContext
  projectId
  backend
  machineId?
  workspace
  agent
  repository?
  branch?
  head?
  dirty?
  ahead?
  behind?
  capabilities[]
  previousTarget?
  resolutionReason
```

This normalized structure is what downstream UI/tool-context injection should consume.

Adapters should not independently invent their own Project/Machine semantics.

## 16. ChatGPT Project identity problem

A critical unknown is how normal Chat exposes the current ChatGPT Project identity to a desktop/local MCP integration.

Preferred order:

1. normal Chat + desktop/local MCP receives enough project identity directly;
2. the Windows client can expose current Project identity through a supported/local integration point;
3. only if needed, add a **thin Windows-app patch** that observes the current `g-p-...` Project identity and forwards it to the local resolver.

Do not begin by broadly patching the official app.

The patch, if required, should identify/rout context. It should not duplicate filesystem, shell, Worker, or Computer Use implementation already present in ChatGPT2Codex.

## 17. Desktop MCP vs Windows-app patch

The two mechanisms have different responsibilities.

### Desktop/local MCP

Provides execution capabilities:

- file access;
- shell;
- git;
- Computer Use;
- workers;
- local state inspection.

### Thin Windows-app integration/patch, if required

Provides UX/context that MCP cannot otherwise know:

- current ChatGPT Project identity;
- current application/machine context;
- execution target selector/badge;
- local workspace binding UI.

If MCP can reliably receive the current Project identity without a patch, prefer no patch.

## 18. Example end-to-end flows

### 18.1 Main PC -> VMware, same chat

MAIN-PC:

```text
Project  = chatgpt2codex
Backend  = local
Machine  = MAIN-PC
Agent    = chatgpt-chat
Root     = C:\Dev\chatgpt2codex
```

User asks for code changes and local testing.

Later the same ChatGPT chat is opened inside VMware.

Resolver emits:

```text
previous = MAIN-PC/local
current  = VMWARE-DEV/local
```

The user can immediately say:

> Build that again here and check the UI.

The model already knows the current target is VMware.

If MAIN-PC had dirty/unpublished state, the transition reports that the VMware checkout may not contain those edits.

### 18.2 Local -> GitHub

The user was doing local testing, then continues from a device without ChatGPT2Codex.

Resolver chooses GitHub.

If local state was already pushed, work can continue immediately.

If not, the conversation may still remember the intent, but GitHub actions must operate only on the repository state GitHub actually contains.

### 18.3 GitHub -> local

GitHub modifies/pushes repository state while the user's PC is off.

Later MAIN-PC becomes available.

Local target resolution should compare local branch/HEAD/upstream before assuming the local checkout contains the GitHub changes.

### 18.4 ChatGPT -> Codex or Claude Code

The logical Project remains unchanged.

Only `agent` and possibly `workspace/worktree` change.

Conversation continuity and repository state remain separate from the selected coding agent.

## 19. UI direction

A future Windows UI may show:

```text
Project: chatgpt2codex

Execution: Auto
Current: MAIN-PC · Local · ChatGPT

Workspace
C:\Dev\chatgpt2codex

Git
dev/custom-runtime
2 modified · 1 ahead

Agent
ChatGPT
```

On VMware the same Project may display another local root.

On a machine without a binding:

```text
No local workspace is configured for this Project on this machine.

[Select Folder]
```

GitHub remains selectable even when no local binding exists.

## 20. Safety and authority

Execution routing must not silently widen authority.

Examples:

- selecting a local backend does not automatically grant Computer Use;
- Computer Use still requires the established control policy/lease;
- local workspace selection does not permit writes outside the mapped scope;
- Worker isolation remains capability/worktree-based;
- switching Agent does not implicitly inherit another Agent's dirty working tree;
- remote GitHub actions obey GitHub connector/repository permissions;
- cross-machine execution must not infer that uncommitted changes have synchronized.

## 21. Implementation roadmap

This architecture is planned as **M8 - Multi-backend Project Execution**.

### M8.0 - Documentation and invariants

- freeze the six-concept model: Project / Backend / Machine / Workspace / Agent / State;
- document GitHub as a first-class backend;
- document machine-specific bindings;
- document automatic context-change injection;
- define compatibility constraints with current Core/Worker/Computer Use.

Status: **this document**.

### M8.1 - Execution model foundation

Add a new module boundary, tentatively:

```text
src/execution/
  types.ts
  machine.ts
  store.ts
  resolver.ts
```

Add versioned `execution.json`.

Do not alter existing `Project.root` semantics yet.

Focused tests:

- schema/backward compatibility;
- machine binding resolution;
- backend/agent independence;
- Auto resolution;
- missing-binding behavior;
- no mutation of existing sessions/leases.

### M8.2 - Machine identity and local binding

- stable runtime-owned machine identity;
- per-Project machine-local folder binding;
- local binding inspect/set/clear surface;
- path validation and project-root safety reuse.

### M8.3 - Execution state observation

- branch/HEAD;
- clean/dirty;
- ahead/behind when available;
- capability summary;
- transition-risk classification.

This is observation first, not automatic synchronization.

### M8.4 - Chat context injection

- compact current execution context;
- explicit execution-context-change event;
- automatic current-machine/backend identification;
- no need for the user to state "I am on PC 2 now".

### M8.5 - GitHub backend integration

- repository association;
- explicit GitHub execution target;
- Auto fallback to GitHub when local execution is unavailable;
- preserve GitHub operation without requiring any local PC.

Do not couple GitHub correctness to ChatGPT2Codex being online.

### M8.6 - Agent integration

- `chatgpt-chat`;
- Codex;
- Claude Code;
- existing Worker.

Define workspace ownership/worktree policy for simultaneous agents.

### M8.7 - ChatGPT Windows integration

Investigate in this order:

1. can local MCP reliably identify the current ChatGPT Project?;
2. can supported desktop integration provide it?;
3. if not, add the smallest possible Windows-app context patch.

Add target/binding UI only after resolver semantics are stable.

### M8.8 - Handoff workflow

- warn on dirty/local-only state during target transitions;
- explicit publish/push/checkpoint flow where useful;
- never silently claim that another machine sees unpublished local changes.

## 22. Non-goals for early M8

- replacing GitHub with local synchronization;
- automatically committing every local edit;
- automatically pushing before every backend switch;
- mirroring arbitrary dirty working trees between machines;
- making ChatGPT2Codex a general remote desktop service;
- broadly reverse-engineering or replacing ChatGPT Work/Codex internals;
- making Codex or Claude Code share a mutable working tree concurrently without coordination;
- removing the current Project registry/root model before migration is proven;
- changing Worker authorization/isolation merely to fit the new router.

## 23. Acceptance criteria for the architecture

The direction is successful when the following user experience is possible:

1. One ChatGPT Project is associated with one logical repository/project.
2. MAIN-PC and VMWARE-DEV can each bind a different local path to it.
3. The same ChatGPT chat can be opened on either machine.
4. The model automatically knows which execution machine/backend is current.
5. The user can switch between GitHub and local execution without rebuilding project context manually.
6. GitHub work still functions while local PCs are offline.
7. Local work still provides Files/Shell/Computer Use/Worker capabilities when available.
8. Codex and Claude Code can participate as agents without corrupting the meaning of Backend or Machine.
9. A switch never pretends uncommitted/unpushed local state exists on another backend.
10. Existing ChatGPT2Codex Core, Worker, and Computer Use authority boundaries remain intact.

## 24. Current decision

The project should **not** start M8 by patching the ChatGPT Windows app.

Start with the execution data model, machine binding, state resolver, and context contract.

Only after that foundation exists should the project test whether normal Chat can obtain the current ChatGPT Project identity through desktop MCP. A thin client patch is the fallback for Project identity and UX integration, not the new execution engine.
