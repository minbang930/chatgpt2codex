import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../types.js";
import { installSkill, readSkillProvenance, removeSkill, updateSkill } from "../skills/install.js";
import { discoverSkillRegistry, loadRegisteredSkill } from "../skills/registry.js";
import type { SkillScope } from "../skills/types.js";
import { resolveActiveProject } from "../workspace/active.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { addToolCallProof } from "./tool-proof.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const localWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const networkWrite = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const securitySchemes = [{ type: "oauth2", scopes: ["chatgpt2codex"] }] as const;
const scopeSchema = z.enum(["global", "project"]);
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

export function registerSkillTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skill_list",
    {
      title: "List Agent Skills",
      description:
        "List installed Agent Skills using lightweight name/description/scope metadata. Project skills override global skills with the same name.",
      annotations: readOnly,
      _meta: meta("Listing Agent Skills...", "Agent Skills listed"),
      inputSchema: { query: z.string().max(200).optional() },
    },
    async (input) => {
      try {
        const project = await projectForRead(ctx);
        const snapshot = await discoverSkillRegistry({ stateDir: ctx.stateDir, projectRoot: project?.root });
        const needle = input.query?.trim().toLowerCase();
        const filtered = needle
          ? snapshot.skills.filter((skill) => `${skill.name}\n${skill.description}`.toLowerCase().includes(needle))
          : snapshot.skills;
        const skills = await Promise.all(filtered.map(async (skill) => {
          const provenance = await readSkillProvenance(skill.baseDir);
          return {
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            managed: provenance !== null,
            sourceKind: provenance?.sourceKind,
          };
        }));
        return ok(
          "skill_list",
          makeResult(
            {
              skills,
              diagnostics: snapshot.diagnostics.slice(0, 20),
              activeProjectId: project?.projectId,
            },
            skills.length === 0 ? "No matching Agent Skills are installed." : `Found ${skills.length} Agent Skill(s).`,
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
      description: "Load the full SKILL.md for one installed skill only when its instructions are needed.",
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
        return ok(
          "skill_view",
          makeResult(
            {
              name: loaded.skill.name,
              description: loaded.skill.description,
              scope: loaded.skill.scope,
              content: loaded.skill.content,
              managed: provenance !== null,
              sourceKind: provenance?.sourceKind,
              diagnostics: loaded.diagnostics.slice(0, 20),
            },
            `Loaded SKILL.md for ${loaded.skill.name}.`,
          ),
        );
      } catch (error) {
        return failed("skill_view", error);
      }
    },
  );

  server.registerTool(
    "skill_install",
    {
      title: "Install Agent Skill",
      description:
        "Install one SKILL.md-based Agent Skill from an HTTPS Git repository or a local directory inside the configured workspace. If the source contains multiple skills, provide skillName. Installs are snapshots and never execute skill scripts.",
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
        "Refresh a managed Agent Skill from the source recorded at install time. Unmanaged/manual skills are never overwritten.",
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
