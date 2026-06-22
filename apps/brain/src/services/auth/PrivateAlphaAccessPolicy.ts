import type { Env } from "../../types/ai";

export function hasPrivateAlphaAccess(login: string, env: Env): boolean {
  const mode = env.PRIVATE_ALPHA_ACCESS_MODE ?? "open";
  if (mode === "open") return true;

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
