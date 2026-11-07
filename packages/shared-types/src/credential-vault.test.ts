import { describe, expect, it } from "vitest";
import {
  CredentialSecretSchema,
  CredentialVaultEntrySchema,
  CredentialVaultSurfaceSchema,
  CredentialVaultUnsupportedOperationError,
  RuntimeCredentialMaterialSchema,
  projectRuntimeCredentialMaterial,
  type RuntimeCredentialMaterial,
} from "./credential-vault.js";

describe("credential vault contracts", () => {
  it("accepts supported vault surfaces", () => {
    expect(CredentialVaultSurfaceSchema.safeParse("cloud").success).toBe(true);
    expect(CredentialVaultSurfaceSchema.safeParse("desktop").success).toBe(true);
    expect(CredentialVaultSurfaceSchema.safeParse("mobile").success).toBe(false);
  });

  it("validates provider-neutral vault entries", () => {
    const parsed = CredentialVaultEntrySchema.safeParse({ providerId: "openai" });
    expect(parsed.success).toBe(true);

    const apiKey = CredentialSecretSchema.parse({ type: "api_key", apiKey: "fixture-key" });
    const oauth = CredentialSecretSchema.options[1].parse({
      type: "oauth",
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh-custody-only",
      expiresAt: 1_900_000_000_000,
      accountId: "fixture-account",
      issuer: "https://issuer.invalid",
      clientId: "fixture-client",
      scopes: ["fixture-scope"],
    });
    const external = CredentialSecretSchema.parse({
      type: "external_reference",
      authority: "provider_owned",
      referenceId: "11111111-1111-4111-8111-111111111111",
    });
    const projectedKey: RuntimeCredentialMaterial = projectRuntimeCredentialMaterial(apiKey);
    const projectedOAuth: RuntimeCredentialMaterial = projectRuntimeCredentialMaterial(oauth);
    const projectedExternal: RuntimeCredentialMaterial = projectRuntimeCredentialMaterial(external);
    expect(projectedKey).toEqual(apiKey);
    expect(projectedOAuth).toEqual({
      type: "oauth", accessToken: "fixture-access",
      expiresAt: 1_900_000_000_000, accountId: "fixture-account",
    });
    expect(projectedExternal).toEqual(external);
    expect(JSON.stringify(projectedOAuth)).not.toContain("fixture-refresh-custody-only");
    for (const field of ["refreshToken", "issuer", "clientId", "scopes"] as const) {
      expect(Object.hasOwn(projectedOAuth, field)).toBe(false);
      expect(RuntimeCredentialMaterialSchema.safeParse({ ...projectedOAuth, [field]: oauth[field] }).success).toBe(false);
    }
    expect(RuntimeCredentialMaterialSchema.safeParse(oauth).success).toBe(false);
    for (const material of [projectedKey, projectedOAuth, projectedExternal]) {
      expect(RuntimeCredentialMaterialSchema.parse(material)).toEqual(material);
      expect(RuntimeCredentialMaterialSchema.safeParse({ ...material, extra: "not-runtime-material" }).success).toBe(false);
    }

    // Runtime material inherits custody bounds instead of accepting a wider
    // transport-only credential shape.
    expect(RuntimeCredentialMaterialSchema.safeParse({ type: "api_key", apiKey: "k".repeat(4096) }).success).toBe(true);
    expect(RuntimeCredentialMaterialSchema.safeParse({ ...projectedOAuth, accessToken: "a".repeat(16384), accountId: "i".repeat(512), expiresAt: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    for (const material of [
      { type: "api_key", apiKey: "" },
      { type: "api_key", apiKey: "k".repeat(4097) },
      { ...projectedOAuth, accessToken: "" },
      { ...projectedOAuth, accessToken: "a".repeat(16385) },
      { ...projectedOAuth, accountId: "" },
      { ...projectedOAuth, accountId: "i".repeat(513) },
      { ...projectedOAuth, expiresAt: -1 },
      { ...projectedOAuth, expiresAt: 1.5 },
      { ...projectedOAuth, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { type: "oauth", accessToken: "fixture-access", expiresAt: 0 },
      { ...projectedExternal, authority: "caller_owned" },
      { ...projectedExternal, referenceId: "not-a-reference" },
      { type: "unknown", apiKey: "fixture-key" },
    ]) {
      expect(RuntimeCredentialMaterialSchema.safeParse(material).success).toBe(false);
    }
  });

  it("provides deterministic unsupported-operation error details", () => {
    const error = new CredentialVaultUnsupportedOperationError(
      "desktop",
      "setCredential",
    );
    expect(error.name).toBe("CredentialVaultUnsupportedOperationError");
    expect(error.message).toContain("setCredential");
    expect(error.message).toContain("desktop");
  });
});
