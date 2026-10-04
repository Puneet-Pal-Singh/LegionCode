import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ProviderConnectionConfigSchema,
  ProviderIdSchema,
  type ProviderConnectionConfig,
  type ProviderId,
  type CredentialVault,
} from "@repo/shared-types";

type SafeStoragePort = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type VaultFile = { version: 1; credentials: Record<string, string> };
type CredentialValue = {
  apiKey: string;
  connectionConfig?: ProviderConnectionConfig;
};

const MAX_VAULT_BYTES = 128 * 1024;
const MAX_CREDENTIAL_BYTES = 4096;

/** Main-process-only adapter. The file contains OS-encrypted ciphertext only. */
export class DesktopCredentialVault implements CredentialVault {
  readonly surface = "desktop" as const;
  private loaded: VaultFile | null = null;
  private loadPromise: Promise<VaultFile> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(
    userDataPath: string,
    private readonly safeStorage: SafeStoragePort,
  ) {
    this.filePath = join(userDataPath, "provider-credentials", "credentials.enc.json");
  }

  async status(providerId: ProviderId): Promise<"present" | "missing" | "unavailable"> {
    try {
      await this.getApiKey(providerId);
      return (await this.hasCredential(providerId)) ? "present" : "missing";
    } catch {
      return "unavailable";
    }
  }

  async listConnectedProviders(): Promise<ProviderId[]> {
    const file = await this.load();
    const providers: ProviderId[] = [];
    for (const rawProviderId of Object.keys(file.credentials)) {
      const parsedProviderId = ProviderIdSchema.safeParse(rawProviderId);
      if (!parsedProviderId.success) throw unavailable();
      await this.getApiKey(parsedProviderId.data);
      providers.push(parsedProviderId.data);
    }
    return providers;
  }

  async setCredential(
    providerId: ProviderId,
    apiKey: string,
    connectionConfig?: ProviderConnectionConfig,
  ): Promise<void> {
    const parsedProviderId = ProviderIdSchema.safeParse(providerId);
    if (!parsedProviderId.success || apiKey.length < 1 || apiKey.length > MAX_CREDENTIAL_BYTES) {
      throw unavailable();
    }
    const parsedConfig = connectionConfig === undefined
      ? undefined
      : ProviderConnectionConfigSchema.safeParse(connectionConfig);
    if (parsedConfig && (!parsedConfig.success || parsedConfig.data.providerId !== providerId)) {
      throw unavailable();
    }
    await this.mutate(async (current) => {
      const value: CredentialValue = {
        apiKey,
        ...(parsedConfig ? { connectionConfig: parsedConfig.data } : {}),
      };
      let encrypted: Buffer;
      try {
        encrypted = this.safeStorage.encryptString(JSON.stringify(value));
      } catch {
        throw unavailable();
      }
      return {
        version: 1,
        credentials: { ...current.credentials, [providerId]: encrypted.toString("base64") },
      };
    });
  }

  async getApiKey(providerId: ProviderId): Promise<string | null> {
    const value = await this.readCredential(providerId);
    return value?.apiKey ?? null;
  }

  async getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    return (await this.readCredential(providerId))?.connectionConfig;
  }

  async deleteCredential(providerId: ProviderId): Promise<void> {
    await this.mutate(async (current) => {
      const credentials = { ...current.credentials };
      delete credentials[providerId];
      return { version: 1, credentials };
    });
  }

  async isConnected(providerId: ProviderId): Promise<boolean> {
    return (await this.getApiKey(providerId)) !== null;
  }

  private async hasCredential(providerId: ProviderId): Promise<boolean> {
    const file = await this.load();
    return providerId in file.credentials;
  }

  private async readCredential(providerId: ProviderId): Promise<CredentialValue | null> {
    const file = await this.load();
    const encoded = file.credentials[providerId];
    if (encoded === undefined) return null;
    try {
      const plaintext = this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
      const value: unknown = JSON.parse(plaintext);
      if (!isCredentialValue(value, providerId)) throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }

  private async load(): Promise<VaultFile> {
    if (!this.safeStorage.isEncryptionAvailable()) throw unavailable();
    if (this.loaded) return this.loaded;
    if (this.loadPromise) return await this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const contents = await readFile(this.filePath);
        if (contents.byteLength > MAX_VAULT_BYTES) throw unavailable();
        const parsed: unknown = JSON.parse(contents.toString("utf8"));
        if (!isVaultFile(parsed)) throw unavailable();
        for (const [rawProviderId, encoded] of Object.entries(parsed.credentials)) {
          const providerId = ProviderIdSchema.safeParse(rawProviderId);
          if (!providerId.success) throw unavailable();
          const plaintext = this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
          const credential: unknown = JSON.parse(plaintext);
          if (!isCredentialValue(credential, providerId.data)) throw unavailable();
        }
        this.loaded = parsed;
        return parsed;
      } catch (error) {
        if (isNotFound(error)) {
          const empty: VaultFile = { version: 1, credentials: {} };
          this.loaded = empty;
          return empty;
        }
        throw unavailable();
      } finally {
        this.loadPromise = null;
      }
    })();
    return await this.loadPromise;
  }

  private async commit(next: VaultFile): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      this.loaded = next;
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
      throw unavailable();
    }
  }

  private async mutate(
    makeNext: (current: VaultFile) => Promise<VaultFile>,
  ): Promise<void> {
    const operation = this.writes.then(async () => {
      const current = await this.load();
      const next = await makeNext(current);
      await this.commit(next);
    });
    this.writes = operation.catch(() => undefined);
    await operation;
  }
}

function isVaultFile(value: unknown): value is VaultFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.credentials !== "object" || candidate.credentials === null || Array.isArray(candidate.credentials)) return false;
  return Object.values(candidate.credentials).every((item) =>
    typeof item === "string" && item.length > 0 && item.length <= 32_768 && /^[A-Za-z0-9+/]+=*$/.test(item),
  );
}

function isCredentialValue(value: unknown, providerId: ProviderId): value is CredentialValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.apiKey !== "string" || candidate.apiKey.length < 1 || candidate.apiKey.length > MAX_CREDENTIAL_BYTES) return false;
  if (candidate.connectionConfig === undefined) return true;
  const config = ProviderConnectionConfigSchema.safeParse(candidate.connectionConfig);
  return config.success && config.data.providerId === providerId;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function unavailable(): Error {
  return new Error("Protected provider credentials are unavailable");
}
