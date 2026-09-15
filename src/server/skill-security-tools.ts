import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeResult, type ToolContext } from "../types.js";
import { readSkillProvenance } from "../skills/install.js";
import { readSkillResource } from "../skills/loader.js";
import { loadRegisteredSkill } from "../skills/registry.js";
import { assertExternalSkillSecurity, describeSkillTrust, scanSkillText } from "../skills/security.js";
import { resolveActiveProject } from "../workspace/active.js";
import { addToolCallProof } from "./tool-proof.js";

const skillNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const resourcePathSchema = z.string().min(1).max(1024);

function result(tool: string, value: ReturnType<typeof makeResult>) {
  return { ...value, structuredContent: addToolCallProof(value.structuredContent, tool, value.isError !== true) };
}

async function loadForRead(ctx: ToolContext, name: string) {
  const project = await resolveActiveProject(ctx).catch(() => undefined);
  const loaded = await loadRegisteredSkill({ stateDir: ctx.stateDir, projectRoot: project?.root, name });
  return { project, loaded };
}

export function registerSkillSecurityTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skill_security_status",
    {
      title: "Inspect Agent Skill Trust",
      description: "Return provenance, trust level, and bounded static scan metadata for one installed Agent Skill without returning its instruction body.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { name: skillNameSchema },
    },
    async (input) => {
      const { loaded } = await loadForRead(ctx, input.name);
      if (!loaded.skill) {
        return result("skill_security_status", makeResult({ error: `Skill not found: ${input.name}` }, `Skill not found: ${input.name}`, true));
      }
      const provenance = await readSkillProvenance(loaded.skill.baseDir);
      const trust = describeSkillTrust(provenance);
      const securityScan = scanSkillText(loaded.skill.content);
      return result(
        "skill_security_status",
        makeResult(
          { name: loaded.skill.name, installedScope: loaded.skill.scope, trust, securityScan },
          `Inspected Agent Skill '${loaded.skill.name}'.`,
        ),
      );
    },
  );

  server.registerTool(
    "skill_resource_read",
    {
      title: "Read Agent Skill Resource",
      description: "Read one bounded non-executable file from references, templates, or assets in an installed Agent Skill.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { name: skillNameSchema, path: resourcePathSchema },
    },
    async (input) => {
      const { loaded } = await loadForRead(ctx, input.name);
      if (!loaded.skill) {
        return result("skill_resource_read", makeResult({ error: `Skill not found: ${input.name}` }, `Skill not found: ${input.name}`, true));
      }
      try {
        const resource = await readSkillResource(loaded.skill, input.path);
        const provenance = await readSkillProvenance(loaded.skill.baseDir);
        const trust = describeSkillTrust(provenance);
        const securityScan = resource.encoding === "utf8" ? scanSkillText(resource.content, resource.path) : undefined;
        if (securityScan) assertExternalSkillSecurity(trust, securityScan, "skill resource read");
        return result(
          "skill_resource_read",
          makeResult(
            { name: loaded.skill.name, installedScope: loaded.skill.scope, trust, securityScan, resource },
            `Loaded ${resource.path} from Agent Skill '${loaded.skill.name}'.`,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result("skill_resource_read", makeResult({ error: message }, message, true));
      }
    },
  );
}
