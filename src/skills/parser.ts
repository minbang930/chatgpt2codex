import type { ParsedSkillDocument, SkillFrontmatterValue } from "./types.js";

export const MAX_SKILL_NAME_LENGTH = 128;
export const MAX_SKILL_DESCRIPTION_LENGTH = 2048;

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY_RE = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/;

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function stripYamlComment(value: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "'" && !double) {
      if (single && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      single = !single;
      continue;
    }
    if (char === '"' && !single && value[i - 1] !== "\\") {
      double = !double;
      continue;
    }
    if (char === "#" && !single && !double && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquoteScalar(raw: string): string {
  const value = stripYamlComment(raw).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function splitInlineList(raw: string): string[] | undefined {
  const value = stripYamlComment(raw).trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const body = value.slice(1, -1).trim();
  if (!body) return [];

  const result: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === "'" && !double) {
      if (single && body[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      single = !single;
      current += char;
      continue;
    }
    if (char === '"' && !single && body[i - 1] !== "\\") {
      double = !double;
      current += char;
      continue;
    }
    if (char === "," && !single && !double) {
      result.push(unquoteScalar(current));
      current = "";
      continue;
    }
    current += char;
  }
  result.push(unquoteScalar(current));
  return result.filter((item) => item.length > 0);
}

function parseFrontmatterBlock(lines: string[]): Record<string, SkillFrontmatterValue> {
  const frontmatter: Record<string, SkillFrontmatterValue> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    index += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const match = line.match(KEY_RE);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2] ?? "";
    const trimmed = stripYamlComment(raw).trim();

    if (trimmed === "|" || trimmed === ">") {
      const block: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (candidate.length > 0 && !/^\s/.test(candidate)) break;
        index += 1;
        if (!candidate.trim()) {
          block.push("");
          continue;
        }
        block.push(candidate.replace(/^\s+/, ""));
      }
      frontmatter[key] = trimmed === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
      continue;
    }

    const list = splitInlineList(raw);
    frontmatter[key] = list ?? unquoteScalar(raw);
  }

  return frontmatter;
}

export function parseSkillDocument(rawContent: string): ParsedSkillDocument {
  const content = stripBom(rawContent).replace(/\r\n/g, "\n");
  if (!content.startsWith("---\n")) {
    throw new Error("SKILL.md must start with YAML frontmatter delimited by ---");
  }

  const closing = content.indexOf("\n---", 4);
  if (closing < 0) {
    throw new Error("SKILL.md frontmatter is missing its closing --- delimiter");
  }
  const afterClosing = content.slice(closing + 4);
  if (afterClosing.length > 0 && !afterClosing.startsWith("\n")) {
    throw new Error("SKILL.md closing frontmatter delimiter must be on its own line");
  }

  const frontmatterText = content.slice(4, closing);
  const body = afterClosing.startsWith("\n") ? afterClosing.slice(1) : afterClosing;
  const frontmatter = parseFrontmatterBlock(frontmatterText.split("\n"));
  const nameValue = frontmatter.name;
  const descriptionValue = frontmatter.description;
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";

  if (!name) throw new Error("SKILL.md frontmatter requires a non-empty name");
  if (name.length > MAX_SKILL_NAME_LENGTH || !SKILL_NAME_RE.test(name)) {
    throw new Error(`SKILL.md name must match ${SKILL_NAME_RE} and be at most ${MAX_SKILL_NAME_LENGTH} characters`);
  }
  if (!description) throw new Error("SKILL.md frontmatter requires a non-empty description");
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new Error(`SKILL.md description must be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters`);
  }

  return { name, description, frontmatter, body };
}
