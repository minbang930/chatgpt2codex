import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import {
  MAX_SKILL_CATALOG_CHARS,
  MAX_SKILL_CATALOG_DESCRIPTION_CHARS,
  MAX_SKILL_CATALOG_ITEMS,
  activateSkillName,
  assertSkillCanActivate,
  deactivateSkillName,
  getActivatedSkillSelection,
  type SkillActivationScope,
} from "../skills/activation.js";
import { installSkill, readSkillProvenance, removeSkill, updateSkill } from "../skills/install.js";
import { discoverSkillRegistry, loadRegisteredSkill } from "../skills/registry.js";
import { describeSkillTrust, scanSkillText } from "../skills/security.js";
import type { SkillMetadata, SkillScope } from "../skills/types.js";
import { resolveActiveProject } from "../workspace/active.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { addToolCallProof } from "./tool-proof.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const localWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const networkWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const securitySchemes = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;
const scopeSchema = z.enum(["global", "project"]);
const activationScopeSchema = z.enum(["global", "project"]);
const skillNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

function meta(invoking: string, invoked: string) {
  return {
    securitySchemes,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

function ok(tool: string, result: ReturnType<typeof makeResult>) {
  return { ...result, structuredContent: addToolCallProof(result.structuredContent, tool, result.isError !== true) };
}

function failed(tool: string, error: unknown) {
  const domain = error instanceof DomainError
    ? error
    : new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, error instanceof Error ? error.message : String(error));
  return ok(tool, makeResult({ error: domain.message, code: domain.code }, `Error [${domain.code}]: ${domain.message}`, true));
}

async function projectForRead(ctx: ToolContext) {
  return resolveActiveProject(ctx).catch(() => undefined);
}

async function projectForScope(ctx: ToolContext, scope: SkillScope, write: boolean) {
  if (scope === "global") return projectForRead(ctx);
  const project = await resolveActiveProject(ctx);
  if (!project) {
    throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Project-scoped skill operation requires an active project");
  }
  if (write) await requireProjectLease(ctx, project.projectId, "write");
  return project;
}

function trimCatalogDescription(description: string): { description: string; descriptionTruncated: boolean } {
  if (description.length <= MAX_SKILL_CATALOG_DESCRIPTION_CHARS) {
    return { description, descriptionTruncated: false };
  }
  return {
    description: `${description.slice(0, MAX_SKILL_CATALOG_DESCRIPTION_CHARS - 1)}…`,
    descriptionTruncated: true,
  };
}

function catalogCost(skill: SkillMetadata, description: string): number {
  return skill.name.length + description.length + skill.scope.length + 96;
}

export function registerSkillTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skill_list",
    {
      title: "List Agent Skills",
      description:
        "List a bounded catalog of installed Agent Skills using lightweight name/description/scope/trust metadata. Project skills override global skills with the same name. Use this early when specialized instructions may help, then call skill_activate for the relevant skill instead of loading every SKILL.md.",
      annotations: readOnly,
      _meta: meta("Listing Agent Skills...", "Agent Skills listed"),
      inputSchema: { query: z.string().max(200).optional() },
    },
    async (input) => {
      try {
        const project = await projectForRead(ctx);
        const snapshot = await discoverSkillRegistry({ stateDir: ctx.stateDir, projectRoot: project?.root });
        const activation = await getActivatedSkillSelection(ctx.stateDir, project?.projectId);
        const activeNames = new Set(activation.names);
        const globalActive = new Set(activation.global);
        const projectActive = new Set(activation.project);
        const needle = input.query?.trim().toLowerCase();
        const filtered = needle
          ? snapshot.skills.filter((skill) => `${skill.name}\n${skill.description}`.toLowerCase().includes(needle))
          : snapshot.skills;

        const skills: Array<Record<string, unknown>> = [];
        let catalogChars = 0;
        for (const skill of filtered) {
          if (skills.length >= MAX_SKILL_CATALOG_ITEMS) break;
          const clipped = trimCatalogDescription(skill.description);
          const cost = catalogCost(skill, clipped.description);
          if (catalogChars + cost > MAX_SKILL_CATALOG_CHARS) break;
          const provenance = await readSkillProvenance(skill.baseDir);
          const trust = describeSkillTrust(provenance);
          skills.push({
            name: skill.name,
            description: clipped.description,
            ...(clipped.descriptionTruncated ? { descriptionTruncated: true } : {}),
            scope: skill.scope,
            managed: trust.managed,
            sourceKind: trust.sourceKind,
            trustLevel: trust.level,
            external: trust.external,
            resolvedCommit: trust.resolvedCommit,
            active: activeNames.has(skill.name),
            activationScopes: [
              ...(globalActive.has(skill.name) ? ["global"] : []),
              ...(projectActive.has(skill.name) ? ["project"] : []),
            ],
          });
          catalogChars += cost;
        }
        const truncated = skills.length < filtered.length;
        return ok(
          "skill_list",
          makeResult(
            {
              skills,
              totalMatches: filtered.length,
              truncated,
              catalogLimits: {
                maxItems: MAX_SKILL_CATALOG_ITEMS,
                maxChars: MAX_SKILL_CATALOG_CHARS,
              },
              activeSkillNames: activation.names,
              activationOverflow: activation.overflow,
              diagnostics: snapshot.diagnostics.slice(0, 20),
              activeProjectId: project?.projectId,
            },
            skills.length === 0
              ? "No matching Agent Skills are installed."
              : `Found ${filtered.length} matching Agent Skill(s); returned ${skills.length}${truncated ? " within catalog limits" : ""}.`,
          ),
        );
      } catch (error) {
        return failed("skill_list", error);
      }
    },
  );

  server.registerTool(
    "skill_view",
    {
      title: "View Agent Skill",
      description: "Load one installed SKILL.md with trust and static security metadata. Viewing does not activate the skill for workers.",
      annotations: readOnly,
      _meta: meta("Loading Agent Skill...", "Agent Skill loaded"),
      inputSchema: { name: skillNameSchema },
    },
    async (input) => {
      try {
        const project = await projectForRead(ctx);
        const loaded = await loadRegisteredSkill({
          stateDir: ctx.stateDir,
          projectRoot: project?.root,
          name: input.name,
        });
        if (!loaded.skill) {
          throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Skill not found: ${input.name}`);
        }
        const provenance = await readSkillProvenance(loaded.skill.baseDir);
        const trust = describeSkillTrust(provenance);
        const securityScan = scanSkillText(loaded.skill.content);
        const contentBlocked = trust.external && securityScan.blockingFindings > 0;
        return ok(
          "skill_view",
          makeResult(
            {
              name: loaded.skill.name,
              description: loaded.skill.description,
              scope: loaded.skill.scope,
              ...(contentBlocked ? { contentBlocked: true } : { content: loaded.skill.content }),
              managed: trust.managed,
              sourceKind: trust.sourceKind,
              trust,
              securityScan,
              diagnostics: loaded.diagnostics.slice(0, 20),
            },
            contentBlocked
              ? `External Agent Skill '${loaded.skill.name}' has blocking security findings; its instruction body was withheld.`
              : `Loaded SKILL.md for ${loaded.skill.name}.`,
          ),
        );
      } catch (error) {
        return failed("skill_view", error);
      }
    },
  );

  server.registerTool(
    "skill_activate",
    {
      title: "Activate Agent Skill",
      description:
        "Explicitly activate one installed Agent Skill and return its bounded instructions for the main agent to follow now. External Git skills must pass static security checks first. Global activation applies across projects; project activation is tied to the active project. Activated skills are also supplied to later browser workers without granting any additional tools or permissions.",
      annotations: localWrite,
      _meta: meta("Activating Agent Skill...", "Agent Skill activated"),
      inputSchema: {
        name: skillNameSchema,
        activationScope: activationScopeSchema.default("project"),
      },
    },
    async (input) => {
      try {
        const project = await projectForRead(ctx);
        const activationScope = input.activationScope as SkillActivationScope;
        if (activationScope === "project" && !project) {
          throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "Project-scoped Agent Skill activation requires an active project");
        }
        const loaded = await loadRegisteredSkill({
          stateDir: ctx.stateDir,
          projectRoot: project?.root,
          name: input.name,
        });
        if (!loaded.skill) {
          throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Skill not found: ${input.name}`);
        }
        assertSkillCanActivate(loaded.skill);
        const activation = await activateSkillName({
          stateDir: ctx.stateDir,
          name: loaded.skill.name,
          activationScope,
          projectId: project?.projectId,
        });
        const provenance = await readSkillProvenance(loaded.skill.baseDir);
        const trust = describeSkillTrust(provenance);
        const securityScan = scanSkillText(loaded.skill.content);
        return ok(
          "skill_activate",
          makeResult(
            {
              name: loaded.skill.name,
              description: loaded.skill.description,
              installedScope: loaded.skill.scope,
              activationScope,
              activeProjectId: project?.projectId,
              activeSkillNames: activation.names,
              trust,
              securityScan,
              content: loaded.skill.content,
            },
            `Activated Agent Skill '${loaded.skill.name}' (${activationScope}). Follow the returned SKILL.md instructions for the current task where applicable.`,
          ),
        );
      } catch (error) {
        return failed("skill_activate", error);
      }
    },
  );

  server.registerTool(
    "skill_deactivate",
    {
      title: "Deactivate Agent Skill",
      description:
        "Deactivate one previously selected Agent Skill. This changes only runtime instruction selection; it does not uninstall the skill or modify project files.",
      annotations: localWrite,
      _meta: meta("Deactivating Agent Skill...", "Agent Skill deactivated"),
      inputSchema: {
        name: skillNameSchema,
        activationScope: activationScopeSchema.default("project"),
      },
    },
    async (input) => {
      try {
        const project = await projectForRead(ctx);
        const activationScope = input.activationScope as SkillActivationScope;
        const activation = await deactivateSkillName({
          stateDir: ctx.stateDir,
          name: input.name,
          activationScope,
          projectId: project?.projectId,
        });
        return ok(
          "skill_deactivate",
          makeResult(
            {
              name: input.name,
              activationScope,
              activeProjectId: project?.projectId,
              activeSkillNames: activation.names,
            },
            `Deactivated Agent Skill '${input.name}' (${activationScope}).`,
          ),
        );
      } catch (error) {
        return failed("skill_deactivate", error);
      }
    },
  );

  server.registerTool(
    "skill_install",
    {
      title: "Install Agent Skill",
      description:
        "Install one SKILL.md-based Agent Skill from an HTTPS Git repository or a local directory inside the configured workspace. External Git snapshots must pass bounded static security checks before installation. If the source contains multiple skills, provide skillName. Installs never execute skill scripts.",
      annotations: networkWrite,
      _meta: meta("Installing Agent Skill...", "Agent Skill installed"),
      inputSchema: {
        source: z.string().min(1).max(2048),
        scope: scopeSchema.default("global"),
        skillName: skillNameSchema.optional(),
        ref: z.string().min(1).max(200).refine((value) => !value.startsWith("-"), "ref must not start with '-'").optional(),
      },
    },
    async (input) => {
      try {
        const project = await projectForScope(ctx, input.scope, input.scope === "project");
        const installed = await installSkill({
          stateDir: ctx.stateDir,
          workspaceRoot: ctx.workspaceRoot,
          projectRoot: project?.root,
          scope: input.scope,
          source: input.source,
          skillName: input.skillName,
          ref: input.ref,
        });
        const trust = describeSkillTrust(installed.provenance);
        return ok(
          "skill_install",
          makeResult(
            {
              name: installed.skill.name,
              description: installed.skill.description,
              scope: installed.skill.scope,
              sourceKind: installed.provenance.sourceKind,
              source: installed.provenance.source,
              requestedRef: installed.provenance.requestedRef,
              resolvedCommit: installed.provenance.resolvedCommit,
              installedAt: installed.provenance.installedAt,
              trust,
            },
            `Installed Agent Skill '${installed.skill.name}' in ${installed.skill.scope} scope.`,
          ),
        );
      } catch (error) {
        return failed("skill_install", error);
      }
    },
  );

  server.registerTool(
    "skill_update",
    {
      title: "Update Agent Skill",
      description:
        "Refresh a managed Agent Skill from the source recorded at install time. External Git snapshots must pass bounded static security checks before replacement. Unmanaged/manual skills are never overwritten.",
      annotations: networkWrite,
      _meta: meta("Updating Agent Skill...", "Agent Skill updated"),
      inputSchema: { name: skillNameSchema, scope: scopeSchema },
    },
    async (input) => {
      try {
        const project = await projectForScope(ctx, input.scope, input.scope === "project");
        const updated = await updateSkill({
          stateDir: ctx.stateDir,
          workspaceRoot: ctx.workspaceRoot,
          projectRoot: project?.root,
          scope: input.scope,
          name: input.name,
        });
        const trust = describeSkillTrust(updated.provenance);
        return ok(
          "skill_update",
          makeResult(
            {
              name: updated.skill.name,
              scope: updated.skill.scope,
              sourceKind: updated.provenance.sourceKind,
              source: updated.provenance.source,
              requestedRef: updated.provenance.requestedRef,
              resolvedCommit: updated.provenance.resolvedCommit,
              installedAt: updated.provenance.installedAt,
              updatedAt: updated.provenance.updatedAt,
              trust,
            },
            `Updated Agent Skill '${updated.skill.name}'.`,
          ),
        );
      } catch (error) {
        return failed("skill_update", error);
      }
    },
  );

  server.registerTool(
    "skill_remove",
    {
      title: "Remove Agent Skill",
      description: "Remove a skill installed by ChatGPT2Codex. Manual/unmanaged skill directories are never deleted.",
      annotations: destructive,
      _meta: meta("Removing Agent Skill...", "Agent Skill removed"),
      inputSchema: { name: skillNameSchema, scope: scopeSchema },
    },
    async (input) => {
      try {
        const project = await projectForScope(ctx, input.scope, input.scope === "project");
        await removeSkill({
          stateDir: ctx.stateDir,
          projectRoot: project?.root,
          scope: input.scope,
          name: input.name,
        });
        return ok(
          "skill_remove",
          makeResult({ name: input.name, scope: input.scope, removed: true }, `Removed Agent Skill '${input.name}'.`),
        );
      } catch (error) {
        return failed("skill_remove", error);
      }
    },
  );
}
