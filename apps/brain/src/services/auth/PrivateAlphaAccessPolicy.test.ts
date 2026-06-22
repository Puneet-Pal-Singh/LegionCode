import { describe, expect, it } from "vitest";
import type { Env } from "../../types/ai";
import { hasPrivateAlphaAccess } from "./PrivateAlphaAccessPolicy";

function createEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe("hasPrivateAlphaAccess", () => {
  it("keeps local development open unless allowlist mode is explicit", () => {
    expect(hasPrivateAlphaAccess("developer", createEnv())).toBe(true);
  });

  it("matches configured GitHub logins case-insensitively", () => {
    const env = createEnv({
      PRIVATE_ALPHA_ACCESS_MODE: "allowlist",
      PRIVATE_ALPHA_GITHUB_LOGINS: "Puneet-Pal-Singh, approved-user",
    });

    expect(hasPrivateAlphaAccess("puneet-pal-singh", env)).toBe(true);
    expect(hasPrivateAlphaAccess("unapproved-user", env)).toBe(false);
  });

  it("denies all users when allowlist mode has no configured logins", () => {
    const env = createEnv({ PRIVATE_ALPHA_ACCESS_MODE: "allowlist" });
    expect(hasPrivateAlphaAccess("developer", env)).toBe(false);
  });
});
