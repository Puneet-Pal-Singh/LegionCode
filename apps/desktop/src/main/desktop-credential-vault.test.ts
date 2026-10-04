import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderIdSchema } from "@repo/shared-types";

import { DesktopCredentialVault } from "./desktop-credential-vault";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("DesktopCredentialVault", () => {
  it("stores only OS-encrypted ciphertext and survives replacement, reload, and deletion", async () => {
    const directory = await createDirectory();
    const vault = new DesktopCredentialVault(directory, createSafeStorage());
    const providerId = ProviderIdSchema.parse("openai");

    await vault.setCredential(providerId, "fixture-secret-first");
    await vault.setCredential(providerId, "fixture-secret-replaced");
    const encrypted = await readFile(join(directory, "provider-credentials", "credentials.enc.json"), "utf8");
    expect(encrypted).not.toContain("fixture-secret");
    expect(await vault.getApiKey(providerId)).toBe("fixture-secret-replaced");

    const restarted = new DesktopCredentialVault(directory, createSafeStorage());
    expect(await restarted.status(providerId)).toBe("present");
    await restarted.deleteCredential(providerId);
    expect(await restarted.status(providerId)).toBe("missing");
  });

  it("serializes concurrent provider saves without losing either credential", async () => {
    const vault = new DesktopCredentialVault(await createDirectory(), createSafeStorage());
    await Promise.all([
      vault.setCredential(ProviderIdSchema.parse("openai"), "fixture-openai-secret"),
      vault.setCredential(ProviderIdSchema.parse("anthropic"), "fixture-anthropic-secret"),
    ]);
    expect((await vault.listConnectedProviders()).sort()).toEqual(["anthropic", "openai"]);
  });

  it("preserves the previous value when replacement encryption fails", async () => {
    const directory = await createDirectory();
    let failEncryption = false;
    const storage = createSafeStorage(() => failEncryption);
    const vault = new DesktopCredentialVault(directory, storage);
    const providerId = ProviderIdSchema.parse("openai");
    await vault.setCredential(providerId, "fixture-old-secret");
    const before = await readFile(join(directory, "provider-credentials", "credentials.enc.json"), "utf8");
    failEncryption = true;

    await expect(vault.setCredential(providerId, "fixture-new-secret")).rejects.toThrow(
      "Protected provider credentials are unavailable",
    );
    expect(await readFile(join(directory, "provider-credentials", "credentials.enc.json"), "utf8")).toBe(before);
    expect(await vault.getApiKey(providerId)).toBe("fixture-old-secret");
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
    await expect(restarted.setCredential(providerId, "fixture-replacement-secret")).rejects.toThrow(
      "Protected provider credentials are unavailable",
    );
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it("fails closed when OS-protected encryption is unavailable", async () => {
    const vault = new DesktopCredentialVault(await createDirectory(), createSafeStorage(() => false, false));
    expect(await vault.status(ProviderIdSchema.parse("openai"))).toBe("unavailable");
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
