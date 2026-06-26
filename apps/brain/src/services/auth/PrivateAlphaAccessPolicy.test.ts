import { describe, expect, it } from "vitest";
import type { Env } from "../../types/ai";
import { hasPrivateAlphaAccess } from "./PrivateAlphaAccessPolicy";

function createEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe("hasPrivateAlphaAccess", () => {
  it("denies access when mode is not configured", () => {
    expect(hasPrivateAlphaAccess("developer", createEnv())).toBe(false);
  });

  it("allows localhost OAuth callbacks without alpha allowlist config", () => {
    expect(
      hasPrivateAlphaAccess("developer", createEnv(), {
        requestUrl: "http://localhost:8788/auth/github/callback",
      }),
    ).toBe(true);
    expect(
      hasPrivateAlphaAccess("developer", createEnv(), {
        requestUrl: "http://127.0.0.1:8788/auth/github/callback",
      }),
    ).toBe(true);
  });

  it("does not allow production OAuth callbacks without explicit access", () => {
    expect(
      hasPrivateAlphaAccess("developer", createEnv(), {
        requestUrl: "https://brain.legioncode.dev/auth/github/callback",
      }),
    ).toBe(false);
  });

  it("ignores malformed request URLs when evaluating local access", () => {
    expect(
      hasPrivateAlphaAccess("developer", createEnv(), {
        requestUrl: "not a url",
      }),
    ).toBe(false);
  });

  it("allows all users only when open mode is explicit", () => {
    const env = createEnv({ PRIVATE_ALPHA_ACCESS_MODE: "open" });
    expect(hasPrivateAlphaAccess("developer", env)).toBe(true);
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
