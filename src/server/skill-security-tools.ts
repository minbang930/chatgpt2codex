import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeResult, type ToolContext } from "../types.js";
import { readSkillProvenance } from "../skills/install.js";
import { loadRegisteredSkill } from "../skills/registry.js";
import { describeSkillTrust, scanSkillText } from "../skills/security.js";
import { resolveActiveProject } from "../workspace/active.js";

const skillNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

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
      const project = await resolveActiveProject(ctx).catch(() => undefined);
      const loaded = await loadRegisteredSkill({ stateDir: ctx.stateDir, projectRoot: project?.root, name: input.name });
      if (!loaded.skill) return makeResult({ error: `Skill not found: ${input.name}` }, `Skill not found: ${input.name}`, true);
      const provenance = await readSkillProvenance(loaded.skill.baseDir);
      const trust = describeSkillTrust(provenance);
      const securityScan = scanSkillText(loaded.skill.content);
      return makeResult(
        { name: loaded.skill.name, installedScope: loaded.skill.scope, trust, securityScan },
        `Inspected Agent Skill '${loaded.skill.name}'.`,
      );
    },
  );
}
