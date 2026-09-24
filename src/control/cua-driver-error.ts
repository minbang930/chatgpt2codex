export function cuaToolResultContentText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const value = (item as { text?: unknown }).text;
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    })
    .filter((value): value is string => Boolean(value))
    .join(" | ");
  return text || undefined;
}

export function cuaToolResultError(
  name: string,
  result: unknown,
  structured: Record<string, unknown> | undefined,
): Error {
  const message = cuaToolResultContentText(result);
  const payload = JSON.stringify(structured ?? result);
  return new Error(`${name} failed: ${message ? `${message} ` : ""}${payload}`);
}
