import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CuaDriverVariant = "system" | "fast-path";

export interface ResolvedCuaDriverCommand {
  command: string;
  source: "explicit" | "system" | "fast-path";
  variant: CuaDriverVariant;
}

export function defaultFastPathCuaDriverBin(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const file = platform === "win32" ? "cua-driver.exe" : "cua-driver";
  return path.join(
    homeDir,
    ".local",
    "share",
    "chatgpt2codex",
    "cua-driver",
    "fast-path",
    file,
  );
}

export function cuaDriverVariant(env: NodeJS.ProcessEnv = process.env): CuaDriverVariant {
  const value = (env.CHATGPT2CODEX_CUA_DRIVER_VARIANT ?? "system").trim().toLowerCase();
  if (value === "system" || value === "fast-path") return value;
  throw new Error(
    `Unsupported CHATGPT2CODEX_CUA_DRIVER_VARIANT=${value}; expected system or fast-path`,
  );
}

export function resolveCuaDriverCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    homeDir?: string;
    platform?: NodeJS.Platform;
    exists?: (file: string) => boolean;
  } = {},
): ResolvedCuaDriverCommand {
  const explicit = env.CUA_DRIVER_BIN?.trim();
  if (explicit) {
    return {
      command: explicit,
      source: "explicit",
      variant: cuaDriverVariant(env),
    };
  }

  const variant = cuaDriverVariant(env);
  if (variant === "system") {
    return {
      command: "cua-driver",
      source: "system",
      variant,
    };
  }

  const candidate =
    env.CHATGPT2CODEX_CUA_FAST_PATH_BIN?.trim() ||
    defaultFastPathCuaDriverBin(options.homeDir, options.platform);
  const exists = options.exists ?? existsSync;
  if (!exists(candidate)) {
    throw new Error(
      `CHATGPT2CODEX_CUA_DRIVER_VARIANT=fast-path but the patched Driver was not found at: ${candidate}. ` +
        "Run npm run cua:install-fast-path or set CHATGPT2CODEX_CUA_FAST_PATH_BIN.",
    );
  }

  return {
    command: candidate,
    source: "fast-path",
    variant,
  };
}
