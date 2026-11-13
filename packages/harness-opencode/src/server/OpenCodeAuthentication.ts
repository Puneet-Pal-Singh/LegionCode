import { randomBytes } from "node:crypto";

/** A transport password is independent of the selected provider credential. Never serialize it. */
export function createOpenCodeServerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Input is the selected credential/config overlay, never process.env. Pass the result
 * to createHarnessHost.selectedEnvironment; the host separately preserves actual HOME
 * and its system allowlist. Vault materialization, user identity and OS enforcement stay host-owned.
 * In stdio launch mode OpenCode removes its password before starting tools.
 */
export function openCodeServerEnvironment(
  isolated: Readonly<Record<string, string>>,
  password: string,
): Readonly<Record<string, string>> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(password))
    throw new Error("Invalid OpenCode transport credential.");
  const environment = { ...isolated };
  delete environment.OPENCODE_SERVER_PASSWORD;
  delete environment.OPENCODE_PASSWORD;
  delete environment.OPENCODE_PTY_HANDOFF;
  return Object.freeze({
    ...environment,
    OPENCODE_PASSWORD: password,
    OPENCODE_CLIENT: "legioncode",
    OPENCODE_DB: "opencode.db",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  });
}
