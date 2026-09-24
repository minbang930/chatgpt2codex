import { isControlFullAccess } from "../control/policy.js";

/**
 * Owner-controlled opt-in for ChatGPT-triggered network/egress commands.
 *
 * Default is off. The Windows launcher/tray persists the user's choice and
 * exports CHATGPT2CODEX_NETWORK_CHATGPT to the runtime process. Explicit
 * Full/Admin mode is also an owner opt-in to unrestricted project authority,
 * so it implicitly enables network/egress commands.
 */
const NETWORK_CHATGPT_ENV_FLAG = "CHATGPT2CODEX_NETWORK_CHATGPT";

export function isNetworkChatGptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isControlFullAccess(env)) return true;
  const raw = env[NETWORK_CHATGPT_ENV_FLAG];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}
