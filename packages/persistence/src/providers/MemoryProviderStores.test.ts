import { describe, expect, it } from "vitest";
import type { ProviderId } from "@repo/shared-types";
import {
  MemoryCredentialStore,
  MemoryPreferenceStore,
  MemoryProviderAuditLog,
  MemoryProviderModelCacheStore,
  MemoryProviderQuotaStore,
} from "./MemoryProviderStores.js";

const MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Memory provider stores", () => {
  it("stores encrypted credentials and returns decrypted keys", async () => {
    const store = new MemoryCredentialStore(
      "user-1",
      "workspace-1",
      MASTER_KEY,
      "v1",
    );

    const record = await store.setCredential({
      credentialId: "cred-1",
      userId: "user-1",
      providerId: "openai" as ProviderId,
      label: "default",
      apiKey: "sk-test-memory-provider-123456",
    });
    const credentialWithKey = await store.getCredentialWithKey(
      "openai" as ProviderId,
    );

    expect(record.encryptedSecretJson).toContain("AES-256-GCM");
    expect(record.encryptedSecretJson).not.toContain(
      "sk-test-memory-provider-123456",
    );
    expect(credentialWithKey?.apiKey).toBe("sk-test-memory-provider-123456");
  });

  it("keeps preferences scoped by store workspace", async () => {
    const workspaceA = new MemoryPreferenceStore("user-1", "workspace-a");
    const workspaceB = new MemoryPreferenceStore("user-1", "workspace-b");

    await workspaceA.updatePreferences({
      defaultProviderId: "openai" as ProviderId,
      defaultModelId: "gpt-4o",
    });
    await workspaceB.updatePreferences({
      defaultProviderId: "groq" as ProviderId,
      defaultModelId: "llama-3.3-70b-versatile",
    });
    await workspaceA.setCredentialLabel("cred-1", "Primary");

    expect((await workspaceA.getPreferences()).defaultProviderId).toBe(
      "openai",
    );
    expect((await workspaceB.getPreferences()).defaultProviderId).toBe("groq");
    expect(
      (await workspaceB.getPreferences()).credentialLabels["cred-1"],
    ).toBeUndefined();
  });

  it("tracks audit events, quota, and model caches", async () => {
    const audit = new MemoryProviderAuditLog();
    const quota = new MemoryProviderQuotaStore();
    const cache = new MemoryProviderModelCacheStore();

    await audit.appendAuditEvent({
      eventType: "connect",
      status: "success",
      providerId: "openai" as ProviderId,
    });
    await quota.setAxisQuotaUsage("2026-05-15", 2);
    await cache.setModelCache({
      providerId: "openai",
      models: [{ id: "gpt-4o", name: "GPT-4o", providerId: "openai" }],
      fetchedAt: "2026-05-15T00:00:00.000Z",
      expiresAt: "2026-05-16T00:00:00.000Z",
      source: "provider_api",
    });

    expect(audit.listEvents()).toHaveLength(1);
    expect(await quota.incrementAndGetQuota("2026-05-15")).toBe(3);
    expect((await cache.getModelCache("openai"))?.source).toBe("cache");
  });
});
