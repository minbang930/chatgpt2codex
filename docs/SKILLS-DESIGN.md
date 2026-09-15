# Agent Skills / Extensions Design

This document defines the M5 extension architecture for `dev/custom-runtime`.

## Goal

Support portable `SKILL.md`-based Agent Skills from local directories and Git repositories without destabilizing the existing Core coding runtime.

The desired user experience is:

```text
install a skill from GitHub or a local source
 -> discover only lightweight metadata by default
 -> load full SKILL.md only when needed
 -> optionally load support files on demand
 -> keep executable content and external MCP servers behind separate reviewed boundaries
```

This is distinct from the existing M4 lifecycle-hook engine. Skills are model instructions/resources, not hook commands and not durable worker state.

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

Initial roots:

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

M5.1 does not add bundled skills or plugin-provided skill roots yet.

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

M5.1 parses the top-level metadata required for discovery without introducing a general YAML dependency. Full/nested manifest semantics can be added only when a concrete skill feature needs them.

## Progressive disclosure

Do not place every installed skill body into every prompt.

The intended disclosure model is:

```text
Tier 0: registry metadata
  name + description + scope

Tier 1: full SKILL.md
  loaded explicitly when the skill is selected

Tier 2: support resource
  references/assets/templates/scripts loaded explicitly by path
```

M5.1 implements the safe metadata/full-skill primitives. M5.2 exposes Tier 0 through `skill_list` and Tier 1 through `skill_view`; support-resource reads remain deferred to M5.4.

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

Executable skill content remains disabled by default until a later M5 security/approval unit explicitly defines it.

## M5.2 management contract

The Core MCP surface now exposes five fixed Agent Skills tools:

```text
skill_list
skill_view
skill_install
skill_update
skill_remove
```

`skill_list` returns bounded discovery metadata and never returns the full instruction body. `skill_view` resolves project-over-global precedence and returns the selected `SKILL.md` only when the agent asks for it.

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
 -> atomically place it under project/global skills
```

The copied package is bounded to 2048 regular files and 32 MiB. Symlinks and unsupported filesystem entries are rejected, VCS metadata is not copied, and no file in `scripts/` or elsewhere is executed during discovery, install, update, list, or view.

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

### M5.3 - Skill activation

- expose a bounded installed-skill catalog to the main ChatGPT agent.
- make skill selection explicit and predictable for the main agent.
- add selected skills to the existing browser-worker bootstrap path.
- preserve the original durable worker task; skill adaptation remains launch-time instruction context, matching the M4.5 Ponytail separation.
- keep catalog/instruction context size bounded.

### M5.4 - Skill resources and security

- bounded reads from `references/`, `templates/`, and `assets/`.
- executable `scripts/` remain disabled unless a reviewed execution contract is added.
- external-source trust/provenance reporting.
- static checks for obvious secret-exfiltration, prompt-injection/persistence, destructive, and agent-config modification patterns before install/activation.
- explicit approval for any future executable install/resource path.

### M5.5 - External MCP plugins

- separate optional Plugins connector.
- external MCP discovery/configuration.
- plugin failure isolation from Core.
- optional plugin-provided skill roots only through explicit manifest/configuration.

Workers do not automatically inherit external plugin tools. Any future worker plugin access must use an explicit allowlist/capability boundary just like the existing worker-scoped Core tools.

## Non-goals through M5.2

M5.1/M5.2 do not:

- execute skill scripts or install commands.
- install npm/pip/brew/etc dependencies declared by third-party content.
- inject all installed skills into prompts.
- automatically grant external MCP tools to workers.
- implement a public marketplace or registry.
- treat a mutable Git checkout as an installed skill.
