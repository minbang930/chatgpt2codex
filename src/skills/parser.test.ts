import { describe, expect, it } from "vitest";
import { parseSkillDocument } from "./parser.js";

describe("skills/parser", () => {
  it("parses standard Agent Skills frontmatter without a YAML dependency", () => {
    const parsed = parseSkillDocument(`---\nname: design-taste-frontend\ndescription: Anti-slop frontend skill for redesigns.\ntags: [frontend, \"design systems\"]\n---\n# Instructions\nShip the page.\n`);
    expect(parsed.name).toBe("design-taste-frontend");
    expect(parsed.description).toBe("Anti-slop frontend skill for redesigns.");
    expect(parsed.frontmatter.tags).toEqual(["frontend", "design systems"]);
    expect(parsed.body).toContain("# Instructions");
  });

  it("supports quoted and folded descriptions used by portable skill files", () => {
    const parsed = parseSkillDocument(`---\nname: docs-helper\ndescription: >\n  Search the documentation first,\n  then apply only the relevant guidance.\nplatforms: [windows, linux]\n---\nDo the work.\n`);
    expect(parsed.description).toBe("Search the documentation first, then apply only the relevant guidance.");
    expect(parsed.frontmatter.platforms).toEqual(["windows", "linux"]);
  });

  it("ignores nested metadata while retaining the top-level fields needed for discovery", () => {
    const parsed = parseSkillDocument(`---\nname: safe-skill\ndescription: Works everywhere\nmetadata:\n  owner: example\n  nested: value\n---\nBody\n`);
    expect(parsed.frontmatter.metadata).toBe("");
    expect(parsed.frontmatter).not.toHaveProperty("owner");
  });

  it("rejects missing required metadata and unsafe names", () => {
    expect(() => parseSkillDocument("# no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseSkillDocument("---\nname: missing-description\n---\nBody")).toThrow(/description/);
    expect(() => parseSkillDocument("---\nname: ../escape\ndescription: nope\n---\nBody")).toThrow(/name must match/);
  });
});
