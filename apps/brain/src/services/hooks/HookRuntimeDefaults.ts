import {
  HookInvocationIdSchema,
  type HookInvocationId,
} from "@repo/hook-protocol";
import type {
  HookClock,
  HookInvocationIdFactory,
  HookPayloadDigester,
} from "./HookRuntimePorts";

export class SystemHookClock implements HookClock {
  nowMs(): number {
    return Date.now();
  }
}

export class WebCryptoHookInvocationIdFactory
  implements HookInvocationIdFactory
{
  next(): HookInvocationId {
    return HookInvocationIdSchema.parse(
      `hki_${crypto.randomUUID().replaceAll("-", "")}`,
    );
  }
}

export class WebCryptoHookPayloadDigester implements HookPayloadDigester {
  async digest(value: unknown): Promise<string> {
    const serialized = JSON.stringify(toCanonicalJson(value));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serialized),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
}

function toCanonicalJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Hook audit payloads must contain finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toCanonicalJson);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, toCanonicalJson(entry)]),
    );
  }
  throw new Error("Hook audit payload contains an unsupported value.");
}
