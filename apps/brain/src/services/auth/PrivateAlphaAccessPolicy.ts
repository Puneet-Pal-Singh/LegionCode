import type { Env } from "../../types/ai";

interface PrivateAlphaAccessContext {
  requestUrl?: string;
}

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function hasPrivateAlphaAccess(
  login: string,
  env: Env,
  context: PrivateAlphaAccessContext = {},
): boolean {
  if (isLocalhostRequest(context.requestUrl)) return true;

  const mode = env.PRIVATE_ALPHA_ACCESS_MODE?.trim().toLowerCase();
  if (mode === "open") return true;
  if (mode !== "allowlist") return false;

  const allowedLogins = new Set(
    (env.PRIVATE_ALPHA_GITHUB_LOGINS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowedLogins.has(login.trim().toLowerCase());
}

export function getPrivateAlphaWaitlistUrl(env: Env): string {
  return (
    env.PRIVATE_ALPHA_WAITLIST_URL ??
    "https://legioncode.dev/cloud/?access=pending"
  );
}

function isLocalhostRequest(requestUrl: string | undefined): boolean {
  if (!requestUrl) return false;

  try {
    return LOCALHOST_NAMES.has(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}
