import {
  buildRuntimeEventSignatureBase,
  formatRuntimeEventSignature,
  INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER,
  INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER,
  type InternalRuntimeEventRequest,
} from "@repo/shared-types";

const BRAIN_RUNTIME_EVENT_URL = "https://internal/internal/runtime/events";

export interface InternalRuntimeEventClientConfig {
  brain: RuntimeEventTarget;
  secret: string;
  now?: () => number;
}

export interface RuntimeEventTarget {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface RuntimeEventPublisher {
  publish(event: InternalRuntimeEventRequest): Promise<void>;
}

export class InternalRuntimeEventClient implements RuntimeEventPublisher {
  private readonly now: () => number;

  constructor(private readonly config: InternalRuntimeEventClientConfig) {
    this.now = config.now ?? (() => Date.now());
  }

  async publish(event: InternalRuntimeEventRequest): Promise<void> {
    const rawBody = JSON.stringify(event);
    const timestamp = String(this.now());
    const signature = await signRuntimeEvent(
      this.config.secret,
      timestamp,
      rawBody,
    );
    const startedAt = Date.now();
    console.log(
      `[runtime-event/client] eventType=${formatLogValue(event.eventType)} idempotencyKey=${formatLogValue(event.idempotencyKey)} runId=${formatLogValue(readPayloadString(event.payload, "runId") ?? "missing")} sessionId=${formatLogValue(readPayloadString(event.payload, "sessionId") ?? "missing")} status=dispatching bodyBytes=${rawBody.length}`,
    );
    const response = await this.config.brain.fetch(BRAIN_RUNTIME_EVENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER]: timestamp,
        [INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
    });

    if (!response.ok) {
      console.error(
        `[runtime-event/client] eventType=${formatLogValue(event.eventType)} idempotencyKey=${formatLogValue(event.idempotencyKey)} runId=${formatLogValue(readPayloadString(event.payload, "runId") ?? "missing")} sessionId=${formatLogValue(readPayloadString(event.payload, "sessionId") ?? "missing")} status=failed httpStatus=${response.status} elapsedMs=${Date.now() - startedAt}`,
      );
      throw new Error(
        `Brain runtime event ingestion returned ${response.status}`,
      );
    }
    console.log(
      `[runtime-event/client] eventType=${formatLogValue(event.eventType)} idempotencyKey=${formatLogValue(event.idempotencyKey)} runId=${formatLogValue(readPayloadString(event.payload, "runId") ?? "missing")} sessionId=${formatLogValue(readPayloadString(event.payload, "sessionId") ?? "missing")} status=accepted httpStatus=${response.status} elapsedMs=${Date.now() - startedAt}`,
    );
  }
}

async function signRuntimeEvent(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = buildRuntimeEventSignatureBase(timestamp, rawBody);
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return formatRuntimeEventSignature(bytesToHex(new Uint8Array(digest)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readPayloadString(
  payload: InternalRuntimeEventRequest["payload"],
  key: string,
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function formatLogValue(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
