import { DomainError, ErrorCode } from "../types.js";

export type WindowsBackendMode = "legacy" | "cua";

export function windowsBackendMode(env: NodeJS.ProcessEnv = process.env): WindowsBackendMode {
  const value = (env.CHATGPT2CODEX_WINDOWS_BACKEND ?? "legacy").trim().toLowerCase();
  if (value === "legacy" || value === "cua") return value;
  throw new DomainError(
    ErrorCode.NOT_IMPLEMENTED,
    \`Unsupported CHATGPT2CODEX_WINDOWS_BACKEND=\${value}; expected legacy or cua\`,
  );
}

export function isCuaWindowsBackend(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === "win32" && windowsBackendMode(env) === "cua";
}
