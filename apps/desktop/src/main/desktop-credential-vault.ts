import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RuntimeCredentialReferenceSchema, sameRuntimeCredentialReference, type RuntimeCredentialLease, type RuntimeCredentialReference } from "./runtime-credentials";

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

type LegacyVaultFile = { version: 1; credentials: Record<string, string> };
type VaultEntry = Omit<RuntimeCredentialReference, "providerId"> & { ciphertext: string };
type VaultFile = { version: 2; credentials: Record<string, VaultEntry> };
type StoredVaultFile = LegacyVaultFile | VaultFile;
export type DesktopRuntimeCredential = {
  apiKey: string;
  connectionConfig?: ProviderConnectionConfig;
};

const MAX_VAULT_BYTES = 128 * 1024;
const MAX_CREDENTIAL_BYTES = 4096;

/** Main-process-only adapter. The file contains OS-encrypted ciphertext only. */
export class DesktopCredentialVault implements CredentialVault {
  readonly surface = "desktop" as const;
  private loaded: StoredVaultFile | null = null;
  private loadPromise: Promise<StoredVaultFile> | null = null;
  private migration: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private durabilityUncertain = false;
  // One bounded authority epoch; any admitted write invalidates all older leases.
  private mutationRevision = 0;
  private pendingMutations = 0;
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
    const file = await this.loadRaw();
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
      const value: DesktopRuntimeCredential = {
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
        version: 2,
        credentials: { ...current.credentials, [providerId]: {
          ...newEntryIdentity(Object.hasOwn(current.credentials, providerId) ? current.credentials[providerId] : undefined),
          ciphertext: encrypted.toString("base64"),
        } },
      };
    });
  }

  async getApiKey(providerId: ProviderId): Promise<string | null> {
    const value = await this.resolveRuntimeCredential(providerId);
    return value?.apiKey ?? null;
  }

  async getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    return (await this.resolveRuntimeCredential(providerId))?.connectionConfig;
  }

  async deleteCredential(providerId: ProviderId): Promise<void> {
    await this.mutate(async (current) => {
      const credentials = { ...current.credentials };
      delete credentials[providerId];
      return { version: 2, credentials };
    });
  }

  async isConnected(providerId: ProviderId): Promise<boolean> {
    return (await this.getApiKey(providerId)) !== null;
  }

  private async hasCredential(providerId: ProviderId): Promise<boolean> {
    const file = await this.loadRaw();
    return Object.hasOwn(file.credentials, providerId);
  }

  /** Trusted main-process read: key and endpoint configuration come from one encrypted value.
   * Never expose this result through renderer IPC, SDK responses or HTTP headers.
   */
  async resolveRuntimeCredential(providerId: ProviderId): Promise<DesktopRuntimeCredential | null> {
    const parsedProviderId = ProviderIdSchema.safeParse(providerId);
    if (!parsedProviderId.success) throw unavailable();
    const file = await this.loadRaw();
    const encoded = ciphertextFor(file, providerId);
    return encoded === undefined ? null : this.decryptCredential(encoded, providerId);
  }

  /** Admission metadata only. Legacy ciphertext is wrapped unchanged by the same writer. */
  async captureRuntimeCredentialReference(providerId: ProviderId, signal?: AbortSignal): Promise<RuntimeCredentialReference | null> {
    const parsedProviderId = ProviderIdSchema.safeParse(providerId);
    if (!parsedProviderId.success || signal?.aborted || this.pendingMutations !== 0) throw unavailable();
    const file = await this.ensureV2();
    this.assertAvailable();
    if (signal?.aborted || this.pendingMutations !== 0 || this.loaded !== file || this.mutationRevision >= Number.MAX_SAFE_INTEGER) throw unavailable();
    const entry = Object.hasOwn(file.credentials, providerId) ? file.credentials[providerId] : undefined;
    return entry ? referenceFor(providerId, entry) : null;
  }

  /** Admitted inference must supply its persisted exact reference. */
  async acquireRuntimeCredentialLease(expected: RuntimeCredentialReference, signal?: AbortSignal): Promise<RuntimeCredentialLease>;
  /** Discovery only; admitted callers must use the exact-reference overload. */
  async acquireRuntimeCredentialLease(providerId: ProviderId, signal?: AbortSignal): Promise<RuntimeCredentialLease>;
  async acquireRuntimeCredentialLease(expected: RuntimeCredentialReference | ProviderId, signal?: AbortSignal): Promise<RuntimeCredentialLease> {
    const reference = typeof expected === "string" ? null : RuntimeCredentialReferenceSchema.parse(expected);
    const providerId = reference?.providerId ?? ProviderIdSchema.parse(expected);
    const revision = this.mutationRevision;
    this.assertAvailable();
    if (signal?.aborted || this.pendingMutations !== 0 || revision >= Number.MAX_SAFE_INTEGER) throw unavailable();
    const file = await this.loadRaw();
    const entry = file.version === 2 && Object.hasOwn(file.credentials, providerId) ? file.credentials[providerId] : undefined;
    if (reference && (!entry || !sameRuntimeCredentialReference(referenceFor(providerId, entry), reference))) throw unavailable();
    const selectedReference = entry ? referenceFor(providerId, entry) : null;
    const encoded = ciphertextFor(file, providerId);
    const credential = encoded === undefined ? null : this.decryptCredential(encoded, providerId);
    const canDeliver = (): boolean => {
      try {
        this.assertAvailable();
        if (signal?.aborted || this.pendingMutations !== 0 || this.mutationRevision !== revision ||
            this.mutationRevision >= Number.MAX_SAFE_INTEGER || this.loaded !== file) return false;
        if (!reference) return true;
        const current = this.loaded.version === 2 && Object.hasOwn(this.loaded.credentials, providerId)
          ? this.loaded.credentials[providerId] : undefined;
        return Boolean(current && sameRuntimeCredentialReference(referenceFor(providerId, current), reference));
      } catch {
        return false;
      }
    };
    if (!canDeliver()) throw unavailable();
    if (credential?.connectionConfig) Object.freeze(credential.connectionConfig);
    return Object.freeze({ credential: credential ? Object.freeze(credential) : null,
      ...(selectedReference ? { reference: selectedReference } : {}), canDeliver });
  }

  private assertAvailable(): void {
    this.assertDurable();
    if (!this.safeStorage.isEncryptionAvailable()) throw unavailable();
  }

  private assertDurable(): void {
    if (this.durabilityUncertain) throw unavailable();
  }

  private decryptCredential(encoded: string, providerId: ProviderId): DesktopRuntimeCredential {
    try {
      this.assertAvailable();
      const value: unknown = JSON.parse(this.safeStorage.decryptString(Buffer.from(encoded, "base64")));
      if (!isDesktopRuntimeCredential(value, providerId)) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }

  /** Envelope/metadata validation only. Loading never decrypts or queues a write. */
  private async loadRaw(): Promise<StoredVaultFile> {
    // Even checking Keychain availability can synchronously prompt on macOS.
    // Empty-profile discovery needs no encryption key; actual credential reads,
    // leases and writes retain their own protected-storage checks.
    this.assertDurable();
    if (this.loaded) return this.loaded;
    if (this.loadPromise) return await this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const contents = await readFile(this.filePath);
        if (contents.byteLength > MAX_VAULT_BYTES) throw unavailable();
        const parsed: unknown = JSON.parse(contents.toString("utf8"));
        if (!isStoredVaultFile(parsed)) throw unavailable();
        this.assertDurable();
        this.loaded = parsed;
        return parsed;
      } catch (error) {
        if (isNotFound(error)) {
          this.assertDurable();
          const empty: VaultFile = { version: 2, credentials: {} };
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

  private async ensureV2(): Promise<VaultFile> {
    const file = await this.loadRaw();
    if (file.version === 2) return file;
    if (!this.migration) {
      // This uses the existing writer directly, not mutate's plaintext validation.
      const operation = this.write(async (current) => current.version === 2 ? null : upgrade(current));
      this.migration = operation;
      void operation.finally(() => { if (this.migration === operation) this.migration = null; }).catch(() => undefined);
    }
    await this.migration;
    const migrated = await this.loadRaw();
    if (migrated.version !== 2) throw unavailable();
    return migrated;
  }

  private async commit(next: VaultFile): Promise<void> {
    const contents = Buffer.from(JSON.stringify(next), "utf8");
    if (contents.byteLength > MAX_VAULT_BYTES || !isStoredVaultFile(next)) throw unavailable();
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomBytes(12).toString("hex")}.tmp`;
    let renamed = false;
    try {
      this.assertAvailable();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
      renamed = true;
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); }
      finally { await directoryHandle.close(); }
      // Only publish the new reference after both file and directory durability.
      this.loaded = next;
    } catch {
      if (renamed) {
        // The new name may exist. Never resume delivery from the previous cache.
        this.durabilityUncertain = true;
        this.loaded = null;
      }
      await unlink(temporaryPath).catch(() => undefined);
      throw unavailable();
    }
  }

  private async mutate(
    makeNext: (current: VaultFile) => Promise<VaultFile>,
  ): Promise<void> {
    return this.write(async (current) => {
      // Preserve ordinary corruption protection before replacing/deleting values.
      for (const rawProviderId of Object.keys(current.credentials)) {
        const providerId = ProviderIdSchema.parse(rawProviderId);
        this.decryptCredential(ciphertextFor(current, providerId)!, providerId);
      }
      return makeNext(current.version === 2 ? current : upgrade(current));
    });
  }

  private async write(makeNext: (current: StoredVaultFile) => Promise<VaultFile | null>): Promise<void> {
    // This runs synchronously at queue admission, before any writer/decrypt/disk await.
    // Never wrap the revision: exhaustion permanently refuses new delivery leases.
    this.assertAvailable();
    if (this.mutationRevision >= Number.MAX_SAFE_INTEGER) throw unavailable();
    this.mutationRevision += 1;
    this.pendingMutations += 1;
    const operation = this.writes.then(async () => {
      const current = await this.loadRaw();
      const next = await makeNext(current);
      if (next) await this.commit(next);
    });
    this.writes = operation.catch(() => undefined);
    try {
      await operation;
    } finally {
      this.pendingMutations -= 1;
    }
  }
}

function isStoredVaultFile(value: unknown): value is StoredVaultFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if ((candidate.version !== 1 && candidate.version !== 2) || Object.keys(candidate).some((key) => key !== "version" && key !== "credentials") ||
      typeof candidate.credentials !== "object" || candidate.credentials === null || Array.isArray(candidate.credentials)) return false;
  return Object.entries(candidate.credentials).every(([providerId, item]) => {
    if (!ProviderIdSchema.safeParse(providerId).success) return false;
    if (candidate.version === 1) return isCiphertext(item);
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return Object.keys(entry).every((key) => ["ciphertext", "connectionId", "ownerGeneration", "tokenMaterialVersion"].includes(key)) &&
      isCiphertext(entry.ciphertext) && RuntimeCredentialReferenceSchema.safeParse({ providerId, connectionId: entry.connectionId,
        ownerGeneration: entry.ownerGeneration, tokenMaterialVersion: entry.tokenMaterialVersion }).success;
  });
}

function isCiphertext(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && /^[A-Za-z0-9+/]+=*$/.test(value);
}

function newEntryIdentity(previous?: VaultEntry): Omit<RuntimeCredentialReference, "providerId"> {
  if (previous && previous.tokenMaterialVersion >= Number.MAX_SAFE_INTEGER) throw unavailable();
  return previous ? { connectionId: previous.connectionId, ownerGeneration: previous.ownerGeneration,
    tokenMaterialVersion: previous.tokenMaterialVersion + 1 }
    : { connectionId: randomUUID(), ownerGeneration: 1, tokenMaterialVersion: 1 };
}

function upgrade(file: LegacyVaultFile): VaultFile {
  return { version: 2, credentials: Object.fromEntries(Object.entries(file.credentials).map(([providerId, ciphertext]) =>
    [providerId, { ...newEntryIdentity(), ciphertext }])) };
}

function ciphertextFor(file: StoredVaultFile, providerId: ProviderId): string | undefined {
  if (!Object.hasOwn(file.credentials, providerId)) return undefined;
  return file.version === 1 ? file.credentials[providerId] : file.credentials[providerId]?.ciphertext;
}

function referenceFor(providerId: ProviderId, entry: VaultEntry): RuntimeCredentialReference {
  return Object.freeze(RuntimeCredentialReferenceSchema.parse({ providerId, connectionId: entry.connectionId,
    ownerGeneration: entry.ownerGeneration, tokenMaterialVersion: entry.tokenMaterialVersion }));
}

function isDesktopRuntimeCredential(value: unknown, providerId: ProviderId): value is DesktopRuntimeCredential {
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
