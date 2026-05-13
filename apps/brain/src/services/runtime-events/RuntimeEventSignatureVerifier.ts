import {
  buildRuntimeEventSignatureBase,
  formatRuntimeEventSignature,
  INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER,
  INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER,
} from "@repo/shared-types";
import { ValidationError } from "../../domain/errors";

const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RuntimeEventSignatureInput {
  rawBody: string;
  headers: Headers;
}

export class RuntimeEventSignatureVerifier {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = () => Date.now(),
    private readonly maxClockSkewMs: number = DEFAULT_MAX_CLOCK_SKEW_MS,
  ) {}

  async verify(input: RuntimeEventSignatureInput): Promise<void> {
    const timestamp = readRequiredHeader(
      input.headers,
      INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER,
    );
    const signature = readRequiredHeader(
      input.headers,
      INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER,
    );

    this.assertFreshTimestamp(timestamp);
    const expected = await this.sign(timestamp, input.rawBody);

    if (!timingSafeEqual(signature, expected)) {
      throw new ValidationError(
        "Invalid runtime event signature",
        "INVALID_RUNTIME_EVENT_SIGNATURE",
      );
    }
  }

  async sign(timestamp: string, rawBody: string): Promise<string> {
    const key = await importHmacKey(this.secret);
    const data = buildRuntimeEventSignatureBase(timestamp, rawBody);
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data),
    );
    return formatRuntimeEventSignature(bytesToHex(new Uint8Array(digest)));
  }

  private assertFreshTimestamp(timestamp: string): void {
    const timestampMs = Number(timestamp);
    if (!Number.isSafeInteger(timestampMs)) {
      throw new ValidationError(
        "Invalid runtime event timestamp",
        "INVALID_RUNTIME_EVENT_TIMESTAMP",
      );
    }

    if (Math.abs(this.now() - timestampMs) > this.maxClockSkewMs) {
      throw new ValidationError(
        "Runtime event timestamp is outside the allowed clock skew",
        "STALE_RUNTIME_EVENT_TIMESTAMP",
      );
    }
  }
}

function readRequiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) {
    throw new ValidationError(
      `Missing ${name} header`,
      "MISSING_RUNTIME_EVENT_SIGNATURE_HEADER",
    );
  }
  return value;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
