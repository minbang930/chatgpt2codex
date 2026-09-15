# Agent Skills / Extensions Design

This document defines the M5 extension architecture for `dev/custom-runtime`.

## Goal

Support portable `SKILL.md`-based Agent Skills from local directories and Git repositories without destabilizing the existing Core coding runtime.

The desired user experience is:

```text
install a skill from GitHub or a local source
 -> discover only lightweight metadata by default
 -> explicitly activate only the skills needed for the task
 -> pass the same bounded instruction context to browser workers
 -> optionally load support files on demand
 -> keep executable content and external MCP servers behind separate reviewed boundaries
```

This is distinct from the existing M4 lifecycle-hook engine. Skills are model instructions/resources, not hook commands, durable worker state, or a capability grant.

## Reference implementations

M5 intentionally borrows proven ideas rather than cloning another agent runtime wholesale.

### Hermes Agent

Useful patterns:

- `skills_list` exposes only name/description/category metadata.
- `skill_view` loads the full `SKILL.md` and requested support files on demand.
- support directories such as `references/`, `templates/`, `assets/`, and `scripts/` are not scanned as independent skills.
- external skill installs are tracked and can be security-scanned before activation.

### OpenClaw

Useful patterns:

- safe local skill loading with a filesystem-root boundary.
- project/global skill precedence and collision reporting.
- Git-source installs stage into a temporary location, capture the resolved commit, then export into a managed skill directory.
- plugin-provided skills are kept distinct from the core skill loader.
- skill prompt/catalog size is bounded.

The custom runtime should implement only the subset needed for ChatGPT2Codex rather than OpenClaw's full library/workshop/remote-node model.

## Storage and precedence

Skill package roots:

```text
Project:
  <project>/.agents/skills/

Global:
  <stateDir>/skills/
```

Precedence:

```text
project > global
```

If a project skill and global skill expose the same `name`, the project skill wins and the registry records a collision diagnostic.

Activation state is runtime-owned and separate from skill packages:

```text
<stateDir>/skill-activations.json
```

It stores a global selected-name list plus project-id-specific selected-name lists. Selection is by skill name; when instructions are loaded, the normal project-over-global registry precedence is applied again so a project override remains authoritative.

M5.1-M5.4 do not add bundled skills or plugin-provided skill roots yet.

## Skill package contract

A skill directory contains:

```text
my-skill/
  SKILL.md
  references/     optional
  templates/      optional
  assets/         optional
  scripts/        optional
```

`SKILL.md` must contain YAML-style frontmatter with at least:

```yaml
---
name: my-skill
description: Short description used for discovery.
---
```

The runtime parses only the top-level metadata required for discovery without introducing a general YAML dependency. Full/nested manifest semantics can be added only when a concrete skill feature needs them.

## Progressive disclosure

Do not place every installed skill body into every prompt.

The disclosure model is:

```text
Tier 0: bounded registry metadata
  name + description + installed scope + active state + trust metadata

Tier 1: one full SKILL.md
  returned by skill_view or explicit skill_activate only after applicable trust checks

Tier 2: activated launch context
  only explicitly selected skills, within deterministic count/character budgets

Tier 3: support resource
  references/assets/templates loaded explicitly by path
```

Executable `scripts/` are intentionally outside Tier 3. M5.1 implements the safe metadata/full-skill primitives. M5.2 exposes discovery and management. M5.3 adds explicit activation plus bounded browser-worker propagation. M5.4 adds bounded support-resource reads plus trust/security checks while keeping scripts non-executable.

## M5.1 safety boundaries

The foundation loader follows these rules:

- skill roots and skill directories must be real directories, not symlinks.
- `SKILL.md` must be a regular non-symlink file.
- canonical paths must remain inside the configured skill root and selected skill directory.
- `SKILL.md` is bounded to 256 KiB.
- discovery is bounded to depth 4 and 256 visited directories per root.
- common repository/dependency directories (`.git`, `.github`, `node_modules`, virtualenv/cache dirs) are skipped.
- once a directory owns a valid `SKILL.md`, discovery does not descend below that skill root; support files therefore cannot accidentally become independent skills.
- discovery never executes scripts, package managers, hooks, or install commands.

Executable skill content remains disabled by default unless a later reviewed execution contract explicitly adds it.

## M5.2 management contract

The management surface exposes:

```text
skill_list
skill_view
skill_install
skill_update
skill_remove
```

`skill_list` returns discovery metadata and never returns the full instruction body. `skill_view` resolves project-over-global precedence and returns the selected `SKILL.md` only when the agent asks for it and applicable trust checks permit instruction disclosure.

### Managed install sources

M5.2 accepts two source classes:

- a local directory inside the configured workspace root;
- an HTTPS Git repository URL.

Local source paths are canonicalized and must remain inside the runtime workspace. The requested local source itself must be a real directory rather than a symlink.

Git sources are cloned into a temporary installation workspace with terminal prompting disabled. Embedded URL credentials are rejected. An optional ref may be fetched explicitly, and the resolved commit SHA is recorded before any content is copied into managed storage.

If a source exposes exactly one valid skill it can be installed directly. If it exposes multiple skills, the caller must provide `skillName`; this supports repositories whose `skills/` directory contains a collection of independent skills without treating the whole repository as one package.

### Snapshot/export semantics

A managed install never points the runtime at a mutable source checkout.

```text
source
 -> temporary/canonical source tree
 -> bounded skill discovery
 -> select one skill root
 -> copy a validated snapshot
 -> write provenance
 -> validate managed copy
 -> for external Git sources: static trust/security gate
 -> atomically place it under project/global skills
```

The copied package is bounded to 2048 regular files and 32 MiB. Symlinks and unsupported filesystem entries are rejected, VCS metadata is not copied, and no file in `scripts/` or elsewhere is executed during discovery, install, update, list, view, activation, or resource reads.

### Provenance

Managed installs contain runtime-owned provenance at:

```text
<skill>/.chatgpt2codex/source.json
```

The record contains:

- source kind (`local` or `git`);
- normalized source;
- installed skill name;
- optional requested Git ref;
- resolved Git commit when applicable;
- install time;
- update time after refresh.

`skill_update` refreshes only a managed install from its recorded source and keeps the original install timestamp. `skill_remove` deletes only a managed install. Existing manual/project-authored skills without valid runtime provenance are never overwritten, updated, or deleted by the management tools.

### Scope and authorization

Global skills are managed under `<stateDir>/skills/`. Project skills are managed under `<project>/.agents/skills/` and project-scoped mutations require the active project plus its existing write lease. The skills subsystem does not create a second project-authorization model.

## M5.3 activation contract

M5.3 adds two explicit selection tools:

```text
skill_activate
skill_deactivate
```

Activation does not install, execute, or authorize anything. It selects instruction content that the main ChatGPT agent may follow immediately and that later browser workers receive as launch-time context.

### Activation scopes

`skill_activate` accepts an activation scope independent of the skill's install scope:

- `global`: the selected skill name is considered for every project context;
- `project`: the selected name is tied to the currently active project.

For one project context, global selections are considered first and project selections are then appended, with duplicate names removed deterministically. The effective skill body is resolved through the normal project-over-global registry, so a project-local skill with the same name overrides the global package.

Project activation changes only runtime selection state. It does not modify project files and therefore does not invent a second filesystem-write authorization model.

### Deterministic budgets

M5.3 keeps both catalog and activated instruction context bounded:

```text
skill_list catalog:
  max 32 returned entries
  max 6,000 approximate metadata characters
  max 500 description characters per entry

activated context:
  max 3 effective active skill names
  max 8,000 characters per activated SKILL.md
  max 24,000 characters across activated skill bodies
```

If a skill exceeds the per-skill activation budget, `skill_activate` rejects activation and the agent can still inspect it explicitly with `skill_view` when the trust gate permits it. Stale or unavailable activation entries are skipped when constructing browser-worker context rather than preventing an otherwise healthy worker from launching.

### Main-agent behavior

`skill_list` reports bounded metadata, trust/source metadata, whether each visible skill is active, its activation scopes, the effective active-name list, and whether catalog truncation occurred. This keeps discovery cheap.

`skill_activate` is the explicit transition from discovery to instruction use. It validates the selected effective skill, applies the external-skill trust/security gate when applicable, persists the activation only after that gate succeeds, and returns that one bounded `SKILL.md` body to the main agent. `skill_deactivate` removes only the requested runtime selection and never uninstalls the package.

### Browser-worker propagation

Initial launch and recovery use the same skill-context adapter:

```text
durable worker.task
 -> Ponytail launch-time adaptation
 -> append currently activated bounded skill instructions
 -> ChatGPT Web worker bootstrap
```

The original durable `worker.task` is never rewritten with skill content. Recovery re-reads the current activation state rather than persisting a skill-expanded task in durable worker state.

Skill-context loading is best-effort at the worker boundary: corrupt/stale optional extension state does not fabricate worker failure or change durable worker state. External Git skills are checked again before their body is injected into worker launch context; a failed check skips that optional skill instead of granting access.

### Capability boundary

Agent Skills are instructions/resources only.

Activation does not:

- alter the worker capability token or its scope;
- add any `worker_*` tool;
- grant normal Core tools to a worker;
- grant Computer Use or external MCP/plugin access;
- execute `scripts/` or dependency installation commands from the skill package.

Any future executable skill or plugin access requires a separate reviewed authorization boundary.

## M5.4 resource and security contract

M5.4 adds two explicit read-only tools:

```text
skill_resource_read
skill_security_status
```

### Resource reads

`skill_resource_read` accepts only paths rooted under:

```text
references/
templates/
assets/
```

The request path must be relative, traversal-free, and resolve canonically inside the selected installed skill. Symlink escapes are rejected. `scripts/` is not in the allowlist.

Reads are bounded. Text resources are returned as text; bounded binary resources may be returned as base64 with explicit encoding metadata. Resource loading never launches an executable, package manager, shell, hook, or dependency installer.

For external Git skills, text resources pass through the same conservative static safety gate before their contents are returned for agent use.

### Trust model

The runtime classifies the effective installed package as:

```text
unmanaged
managed-local
external-git
```

Trust metadata is descriptive, not a capability. A managed local package is not automatically privileged beyond its existing project/global scope, and an external Git package does not gain tool access merely because its provenance is known.

`skill_security_status` reports provenance/trust plus bounded static-scan metadata without returning the full `SKILL.md` body.

### Static safety gate

The M5.4 scanner is intentionally conservative and limited to obvious patterns. Blocking categories include:

- attempts to override higher-priority/system/developer/safety instructions;
- persistence or agent/runtime configuration modification instructions;
- broad destructive filesystem commands;
- instructions to execute packaged `scripts/` content;
- explicit data-exfiltration instructions.

Destructive Git reset/clean patterns are surfaced as warnings rather than silently treated as safe.

The scanner is not a general malware detector and is not treated as proof of safety. For external Git skills, an incomplete or blocking scan fails closed for install/update/activation/instruction disclosure paths that rely on the scanned content. Scanner failure never grants capability and never causes a script to execute.

## M5 units

### M5.1 - Agent Skills foundation — complete

- `SKILL.md` metadata parser.
- safe local loader.
- global/project roots and precedence.
- bounded recursive discovery and collision diagnostics.
- load full selected skill on demand.

### M5.2 - Skill management tools — complete

- `skill_list` / `skill_view` progressive-disclosure tools.
- `skill_install` / `skill_update` / `skill_remove` lifecycle.
- Git/local source support.
- source/ref/resolved-commit provenance.
- project/global target scope.
- managed-only update/removal and bounded snapshot export.

### M5.3 - Skill activation — complete

- bounded `skill_list` catalog with active-state metadata.
- explicit `skill_activate` / `skill_deactivate` selection.
- global and active-project selection layers with deterministic precedence.
- bounded full-skill activation returned to the main agent.
- selected skills appended to initial/recovery browser-worker launch context.
- original durable worker task remains unchanged.
- worker capabilities and tool authorization remain unchanged.

### M5.4 - Skill resources and security — complete

- bounded non-executable reads from `references/`, `templates/`, and `assets/`.
- executable `scripts/` remain disabled.
- explicit trust/provenance reporting for unmanaged, managed-local, and external-Git skills.
- conservative static checks before external-Git install/update/activation and instruction/resource disclosure.
- fail-closed blocking semantics for unsafe/incomplete external-skill validation.
- trust/security metadata exposed without turning trust into a capability grant.

### M5.5 - External MCP plugins

- separate optional Plugins connector.
- external MCP discovery/configuration.
- plugin failure isolation from Core.
- optional plugin-provided skill roots only through explicit manifest/configuration.

Workers do not automatically inherit external plugin tools. Any future worker plugin access must use an explicit allowlist/capability boundary just like the existing worker-scoped Core tools.

## Non-goals through M5.4

M5.1-M5.4 do not:

- execute skill scripts or install commands.
- install npm/pip/brew/etc dependencies declared by third-party content.
- inject every installed skill into prompts.
- automatically select arbitrary third-party skills without an explicit activation step.
- automatically grant external MCP tools to workers.
- implement a public marketplace or registry.
- treat a mutable Git checkout as an installed skill.
- treat static scanning as proof that third-party content is trustworthy.
