import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderIdSchema } from "@repo/shared-types";

import { DesktopCredentialVault } from "./desktop-credential-vault";

const diskFault = vi.hoisted(() => ({ failDirectorySync: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, open: async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await filesystem.open(...args);
    if (args[1] === "r" && diskFault.failDirectorySync) {
      handle.sync = async () => { throw new Error("fixture directory sync failure"); };
    }
    return handle;
  } };
});

const directories: string[] = [];

afterEach(async () => {
  diskFault.failDirectorySync = false;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("DesktopCredentialVault", () => {
  it("stores only OS-encrypted ciphertext and survives replacement, reload, and deletion", async () => {
    const directory = await createDirectory();
    const storage = createSafeStorage();
    const vault = new DesktopCredentialVault(directory, storage);
    const providerId = ProviderIdSchema.parse("openai");

    await vault.setCredential(providerId, "fixture-secret-first");
    const decryptions = storage.decryptString.mock.calls.length;
    const firstReference = await vault.captureRuntimeCredentialReference(providerId);
    expect(firstReference).toMatchObject({ providerId, ownerGeneration: 1, tokenMaterialVersion: 1 });
    expect(storage.decryptString.mock.calls.length).toBe(decryptions);
    const firstLease = await vault.acquireRuntimeCredentialLease(firstReference!);
    expect(firstLease.reference).toEqual(firstReference);
    expect(firstLease.canDeliver()).toBe(true);
    await vault.setCredential(providerId, "fixture-secret-replaced");
    expect(firstLease.canDeliver()).toBe(false);
    await expect(vault.acquireRuntimeCredentialLease(firstReference!)).rejects.toThrow("Protected provider credentials are unavailable");
    const replacementReference = await vault.captureRuntimeCredentialReference(providerId);
    expect(replacementReference).toEqual({ ...firstReference, tokenMaterialVersion: 2 });
    const encrypted = await readFile(join(directory, "provider-credentials", "credentials.enc.json"), "utf8");
    expect(encrypted).not.toContain("fixture-secret");
    expect(await vault.getApiKey(providerId)).toBe("fixture-secret-replaced");
    expect(await vault.resolveRuntimeCredential(providerId)).toEqual({ apiKey: "fixture-secret-replaced" });

    const configuredProvider = ProviderIdSchema.parse("opencode-zen");
    await vault.setCredential(configuredProvider, "fixture-configured-secret", { providerId: "opencode-zen" });
    expect(await vault.resolveRuntimeCredential(configuredProvider)).toEqual({
      apiKey: "fixture-configured-secret",
      connectionConfig: { providerId: "opencode-zen" },
    });
    const restarted = new DesktopCredentialVault(directory, createSafeStorage());
    expect(await restarted.captureRuntimeCredentialReference(providerId)).toEqual(replacementReference);
    const controller = new AbortController();
    const restartedLease = await restarted.acquireRuntimeCredentialLease(replacementReference!, controller.signal);
    controller.abort();
    expect(restartedLease.canDeliver()).toBe(false);
    await expect(restarted.captureRuntimeCredentialReference(providerId, controller.signal)).rejects.toThrow();
    expect(await restarted.resolveRuntimeCredential(configuredProvider)).toEqual({
      apiKey: "fixture-configured-secret",
      connectionConfig: { providerId: "opencode-zen" },
    });
    expect(await restarted.status(providerId)).toBe("present");
    await restarted.deleteCredential(providerId);
    expect(await restarted.status(providerId)).toBe("missing");
    expect(await restarted.resolveRuntimeCredential(providerId)).toBeNull();
    expect(await restarted.captureRuntimeCredentialReference(providerId)).toBeNull();
    await restarted.setCredential(providerId, "fixture-reconnected-secret");
    const reconnectedReference = await restarted.captureRuntimeCredentialReference(providerId);
    expect(reconnectedReference?.connectionId).not.toBe(firstReference?.connectionId);
    expect(reconnectedReference?.tokenMaterialVersion).toBe(1);
    await expect(restarted.acquireRuntimeCredentialLease(replacementReference!)).rejects.toThrow();
  });

  it("serializes concurrent provider saves without losing either credential", async () => {
    const directory = await createDirectory();
    const storage = createSafeStorage();
    const legacyCiphertext = storage.encryptString(JSON.stringify({ apiKey: "fixture-legacy-secret" })).toString("base64");
    const path = join(directory, "provider-credentials", "credentials.enc.json");
    await mkdir(join(directory, "provider-credentials"));
    await writeFile(path, JSON.stringify({ version: 1, credentials: { openai: legacyCiphertext } }));
    storage.encryptString.mockClear();
    const vault = new DesktopCredentialVault(directory, storage);
    const providerId = ProviderIdSchema.parse("openai");
    const references = await Promise.all([vault.captureRuntimeCredentialReference(providerId), vault.captureRuntimeCredentialReference(providerId)]);
    expect(references[0]).toEqual(references[1]);
    expect(storage.decryptString).not.toHaveBeenCalled();
    expect(storage.encryptString).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 2,
      credentials: { openai: { ciphertext: legacyCiphertext, connectionId: references[0]?.connectionId,
        ownerGeneration: 1, tokenMaterialVersion: 1 } } });
    await Promise.all([
      vault.setCredential(providerId, "fixture-openai-secret"),
      vault.setCredential(ProviderIdSchema.parse("anthropic"), "fixture-anthropic-secret"),
    ]);
    expect((await vault.listConnectedProviders()).sort()).toEqual(["anthropic", "openai"]);
    expect(await vault.captureRuntimeCredentialReference(providerId)).toEqual({ ...references[0], tokenMaterialVersion: 2 });

    // Metadata overhead must not turn a readable legacy file into an oversized V2 file.
    const migrationDirectory = await createDirectory();
    const migrationPath = join(migrationDirectory, "provider-credentials", "credentials.enc.json");
    const migrationStorage = createSafeStorage();
    const migrationCiphertext = migrationStorage.encryptString(JSON.stringify({ apiKey: "x".repeat(900) })).toString("base64");
    const legacy = JSON.stringify({ version: 1, credentials: Object.fromEntries(Array.from({ length: 100 }, (_, index) =>
      [`fixture-migration-${index}`, migrationCiphertext])) });
    expect(Buffer.byteLength(legacy)).toBeLessThanOrEqual(128 * 1024);
    await mkdir(join(migrationDirectory, "provider-credentials"));
    await writeFile(migrationPath, legacy);
    migrationStorage.encryptString.mockClear();
    const oversizedMigration = new DesktopCredentialVault(migrationDirectory, migrationStorage);
    await expect(oversizedMigration.captureRuntimeCredentialReference(ProviderIdSchema.parse("fixture-migration-0"))).rejects.toThrow("Protected provider credentials are unavailable");
    expect(await readFile(migrationPath, "utf8")).toBe(legacy);
    expect(migrationStorage.decryptString).not.toHaveBeenCalled();
    expect(migrationStorage.encryptString).not.toHaveBeenCalled();

    // A save must obey the same serialized byte limit as a subsequent process read.
    const fullDirectory = await createDirectory();
    const fullPath = join(fullDirectory, "provider-credentials", "credentials.enc.json");
    const fullCiphertext = storage.encryptString(JSON.stringify({ apiKey: "y".repeat(4096) })).toString("base64");
    const full = JSON.stringify({ version: 2, credentials: Object.fromEntries(Array.from({ length: 23 }, (_, index) =>
      [`fixture-full-${index}`, { ciphertext: fullCiphertext, connectionId: crypto.randomUUID(), ownerGeneration: 1, tokenMaterialVersion: 1 }])) });
    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(128 * 1024);
    await mkdir(join(fullDirectory, "provider-credentials"));
    await writeFile(fullPath, full);
    const fullVault = new DesktopCredentialVault(fullDirectory, storage);
    await expect(fullVault.setCredential(ProviderIdSchema.parse("fixture-full-added"), "z".repeat(4096))).rejects.toThrow("Protected provider credentials are unavailable");
    expect(await readFile(fullPath, "utf8")).toBe(full);
    expect((await new DesktopCredentialVault(fullDirectory, storage).listConnectedProviders()).length).toBe(23);
  });

  it("preserves the previous value when replacement encryption fails", async () => {
    const directory = await createDirectory();
    let failEncryption = false;
    const storage = createSafeStorage(() => failEncryption);
    const vault = new DesktopCredentialVault(directory, storage);
    const providerId = ProviderIdSchema.parse("openai");
    await vault.setCredential(providerId, "fixture-old-secret");
    const reference = await vault.captureRuntimeCredentialReference(providerId);
    const lease = await vault.acquireRuntimeCredentialLease(reference!);
    const before = await readFile(join(directory, "provider-credentials", "credentials.enc.json"), "utf8");
    failEncryption = true;

    await expect(vault.setCredential(providerId, "fixture-new-secret")).rejects.toThrow(
      "Protected provider credentials are unavailable",
    );
    expect(await readFile(join(directory, "provider-credentials", "credentials.enc.json"), "utf8")).toBe(before);
    expect(await vault.getApiKey(providerId)).toBe("fixture-old-secret");
    expect(lease.canDeliver()).toBe(false);
    expect(await vault.captureRuntimeCredentialReference(providerId)).toEqual(reference);
    expect((await vault.acquireRuntimeCredentialLease(reference!)).canDeliver()).toBe(true);
    storage.encryptString.mockReturnValueOnce(Buffer.alloc(25_000));
    await expect(vault.setCredential(providerId, "fixture-oversized-ciphertext")).rejects.toThrow("Protected provider credentials are unavailable");
    expect(await readFile(join(directory, "provider-credentials", "credentials.enc.json"), "utf8")).toBe(before);
    failEncryption = false;
    const durableLease = await vault.acquireRuntimeCredentialLease(reference!);
    diskFault.failDirectorySync = true;
    await expect(vault.setCredential(providerId, "fixture-renamed-secret")).rejects.toThrow("Protected provider credentials are unavailable");
    diskFault.failDirectorySync = false;
    // Rename already happened: refuse the previous cache until a fresh process reads disk.
    expect(durableLease.canDeliver()).toBe(false);
    await expect(vault.captureRuntimeCredentialReference(providerId)).rejects.toThrow();
    await expect(vault.acquireRuntimeCredentialLease(reference!)).rejects.toThrow();
    await expect(vault.setCredential(providerId, "fixture-must-not-overwrite")).rejects.toThrow();
    const restarted = new DesktopCredentialVault(directory, storage);
    expect(await restarted.getApiKey(providerId)).toBe("fixture-renamed-secret");
    expect(await restarted.captureRuntimeCredentialReference(providerId)).toEqual({ ...reference, tokenMaterialVersion: 2 });
  });

  it("reports corrupt ciphertext as unavailable and refuses to overwrite it", async () => {
    const directory = await createDirectory();
    const providerId = ProviderIdSchema.parse("openai");
    const vault = new DesktopCredentialVault(directory, createSafeStorage());
    await vault.setCredential(providerId, "fixture-secret");
    const path = join(directory, "provider-credentials", "credentials.enc.json");
    await writeFile(path, JSON.stringify({ version: 1, credentials: { openai: Buffer.from("broken").toString("base64") } }));
    const corrupt = await readFile(path, "utf8");
    const restarted = new DesktopCredentialVault(directory, createSafeStorage());

    expect(await restarted.status(providerId)).toBe("unavailable");
    await expect(restarted.resolveRuntimeCredential(providerId)).rejects.toThrow("Protected provider credentials are unavailable");
    await expect(restarted.setCredential(providerId, "fixture-replacement-secret")).rejects.toThrow(
      "Protected provider credentials are unavailable",
    );
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it("fails closed when OS-protected encryption is unavailable", async () => {
    const vault = new DesktopCredentialVault(await createDirectory(), createSafeStorage(() => false, false));
    expect(await vault.status(ProviderIdSchema.parse("openai"))).toBe("unavailable");
    await expect(vault.resolveRuntimeCredential(ProviderIdSchema.parse("openai"))).rejects.toThrow("Protected provider credentials are unavailable");
    await expect(vault.captureRuntimeCredentialReference(ProviderIdSchema.parse("openai"))).rejects.toThrow("Protected provider credentials are unavailable");
    await expect(vault.setCredential(ProviderIdSchema.parse("openai"), "fixture-secret")).rejects.toThrow(
      "Protected provider credentials are unavailable",
    );
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "legioncode-credential-vault-"));
  directories.push(directory);
  return directory;
}

function createSafeStorage(
  shouldFail: () => boolean = () => false,
  encryptionAvailable = true,
) {
  return {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: vi.fn((value: string) => {
      if (shouldFail()) throw new Error("fixture storage failure");
      return Buffer.from(`fixture-cipher:${value}`);
    }),
    decryptString: vi.fn((value: Buffer) => {
      const decoded = value.toString("utf8");
      if (!decoded.startsWith("fixture-cipher:")) throw new Error("fixture ciphertext failure");
      return decoded.slice("fixture-cipher:".length);
    }),
  };
}
