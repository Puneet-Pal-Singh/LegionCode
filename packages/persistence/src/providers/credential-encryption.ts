import { z } from "zod";

export const EncryptedSecretSchema = z.object({
  alg: z.literal("AES-256-GCM"),
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  keyVersion: z.string().min(1),
});

export type EncryptedSecret = z.infer<typeof EncryptedSecretSchema>;

export interface EncryptionOptions {
  keyVersion: string;
  masterKey: string;
}

export interface DecryptionOptions {
  masterKey: string;
  previousMasterKey?: string;
}

export interface ICredentialEncryptionService {
  encrypt(
    plaintext: string,
    options: EncryptionOptions,
  ): Promise<EncryptedSecret>;
  decrypt(
    encrypted: EncryptedSecret,
    options: DecryptionOptions,
  ): Promise<string>;
  generateFingerprint(plaintext: string): string;
  isValidKeyFormat(plaintext: string): boolean;
}

export class CredentialEncryptionService {
  private readonly ENCODING = "utf-8";
  private readonly IV_LENGTH = 12;
  private readonly TAG_LENGTH = 128;

  async encrypt(
    plaintext: string,
    options: EncryptionOptions,
  ): Promise<EncryptedSecret> {
    if (!plaintext || plaintext.length === 0) {
      throw new Error("Cannot encrypt empty secret");
    }

    if (!options.keyVersion) {
      throw new Error("keyVersion is required for encryption");
    }

    if (!options.masterKey || options.masterKey.length < 32) {
      throw new Error("Master key must be at least 32 characters");
    }

    try {
      const masterKey = await this.importKey(options.masterKey);
      const iv = crypto.getRandomValues(new Uint8Array(this.IV_LENGTH));
      const plaintextBytes = new TextEncoder().encode(plaintext);
      const ciphertextWithTag = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          tagLength: this.TAG_LENGTH,
        },
        masterKey,
        plaintextBytes,
      );
      const ciphertextWithTagArray = new Uint8Array(ciphertextWithTag);
      const ciphertext = ciphertextWithTagArray.slice(0, -16);
      const tag = ciphertextWithTagArray.slice(-16);

      return {
        alg: "AES-256-GCM",
        ciphertext: this.arrayBufferToBase64(ciphertext),
        iv: this.arrayBufferToBase64(iv),
        tag: this.arrayBufferToBase64(tag),
        keyVersion: options.keyVersion,
      };
    } catch (error) {
      throw new Error(
        `Encryption failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async decrypt(
    encrypted: EncryptedSecret,
    options: DecryptionOptions,
  ): Promise<string> {
    try {
      const parsed = EncryptedSecretSchema.parse(encrypted);
      if (!options.masterKey) {
        throw new Error("No master key available for decryption");
      }

      let plaintext: string | null = null;
      const keysToTry = [options.masterKey, options.previousMasterKey].filter(
        Boolean,
      ) as string[];

      for (const key of keysToTry) {
        try {
          plaintext = await this.decryptWithKey(parsed, key);
          break;
        } catch {
          continue;
        }
      }

      if (plaintext === null) {
        throw new Error("Decryption failed: unable to decrypt with available keys");
      }

      return plaintext;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid encrypted secret format: ${error.message}`);
      }
      throw new Error(
        `Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  generateFingerprint(plaintext: string): string {
    if (plaintext.length < 8) {
      return "***";
    }

    const first4 = plaintext.substring(0, 4);
    const last4 = plaintext.substring(plaintext.length - 4);
    return `${first4}...${last4}`;
  }

  isValidKeyFormat(plaintext: string): boolean {
    if (!plaintext || plaintext.length < 10 || plaintext.length > 4096) {
      return false;
    }
    if (/[\t\n\r\x00-\x08\x0e-\x1f]/.test(plaintext)) {
      return false;
    }
    return true;
  }

  private async decryptWithKey(
    encrypted: EncryptedSecret,
    masterKey: string,
  ): Promise<string> {
    const key = await this.importKey(masterKey);
    const iv = this.base64ToArrayBuffer(encrypted.iv);
    const ciphertext = this.base64ToArrayBuffer(encrypted.ciphertext);
    const tag = this.base64ToArrayBuffer(encrypted.tag);
    const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
    ciphertextWithTag.set(ciphertext, 0);
    ciphertextWithTag.set(tag, ciphertext.length);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv.buffer as ArrayBuffer,
        tagLength: this.TAG_LENGTH,
      },
      key,
      ciphertextWithTag.buffer as ArrayBuffer,
    );

    return new TextDecoder(this.ENCODING).decode(decrypted);
  }

  private async importKey(keyString: string): Promise<CryptoKey> {
    const keyBytes = new TextEncoder().encode(keyString);
    const keyHash = await crypto.subtle.digest("SHA-256", keyBytes);
    return crypto.subtle.importKey(
      "raw",
      keyHash,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  private arrayBufferToBase64(buffer: Uint8Array): string {
    return btoa(String.fromCharCode(...buffer));
  }

  private base64ToArrayBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
}
