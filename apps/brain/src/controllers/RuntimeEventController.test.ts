import { describe, expect, it } from "vitest";
import { MemoryRuntimeEventInboxRepository } from "@repo/persistence";
import {
  INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER,
  INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER,
} from "@repo/shared-types";
import { RuntimeEventController } from "./RuntimeEventController";
import type { Env } from "../types/ai";
import { RuntimeEventIngestionService } from "../services/runtime-events/RuntimeEventIngestionService";
import { RuntimeEventSignatureVerifier } from "../services/runtime-events/RuntimeEventSignatureVerifier";

const NOW = 1778716800000;
const SECRET = "runtime-event-secret";

describe("RuntimeEventController", () => {
  it("accepts signed runtime events", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
    const verifier = new RuntimeEventSignatureVerifier(SECRET, () => NOW);
    const rawBody = createRuntimeEventBody("run-1:tool-1:completed");
    const request = new Request("https://brain.local/internal/runtime/events", {
      method: "POST",
      body: rawBody,
      headers: await signHeaders(verifier, rawBody),
    });

    const response = await RuntimeEventController.acceptInternalRuntimeEvent(
      request,
      createEnv(),
      createDependencies(repository, verifier),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      inserted: true,
      status: "received",
    });
  });

  it("returns ok for duplicate accepted events", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
    const verifier = new RuntimeEventSignatureVerifier(SECRET, () => NOW);
    const rawBody = createRuntimeEventBody("run-1:tool-1:completed");
    const headers = await signHeaders(verifier, rawBody);
    const dependencies = createDependencies(repository, verifier);

    await RuntimeEventController.acceptInternalRuntimeEvent(
      new Request("https://brain.local/internal/runtime/events", {
        method: "POST",
        body: rawBody,
        headers,
      }),
      createEnv(),
      dependencies,
    );
    const response = await RuntimeEventController.acceptInternalRuntimeEvent(
      new Request("https://brain.local/internal/runtime/events", {
        method: "POST",
        body: rawBody,
        headers,
      }),
      createEnv(),
      dependencies,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      inserted: false,
    });
  });

  it("rejects invalid signatures", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
    const verifier = new RuntimeEventSignatureVerifier(SECRET, () => NOW);
    const rawBody = createRuntimeEventBody("run-1:tool-1:completed");
    const headers = await signHeaders(verifier, rawBody);
    headers.set(INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER, "v1=bad");

    const response = await RuntimeEventController.acceptInternalRuntimeEvent(
      new Request("https://brain.local/internal/runtime/events", {
        method: "POST",
        body: rawBody,
        headers,
      }),
      createEnv(),
      createDependencies(repository, verifier),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_RUNTIME_EVENT_SIGNATURE",
    });
  });
});

function createDependencies(
  repository: MemoryRuntimeEventInboxRepository,
  verifier: RuntimeEventSignatureVerifier,
) {
  return {
    async withService<T>(
      _env: Env,
      callback: (service: RuntimeEventIngestionService) => Promise<T>,
    ): Promise<T> {
      return callback(new RuntimeEventIngestionService(repository, verifier, _env));
    },
  };
}

function createRuntimeEventBody(idempotencyKey: string): string {
  return JSON.stringify({
    source: "secure-agent-api",
    eventType: "tool.completed",
    idempotencyKey,
    payloadSchemaVersion: 1,
    payload: { runId: "run-1" },
  });
}

async function signHeaders(
  verifier: RuntimeEventSignatureVerifier,
  rawBody: string,
): Promise<Headers> {
  const timestamp = String(NOW);
  const signature = await verifier.sign(timestamp, rawBody);
  return new Headers({
    [INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER]: signature,
  });
}

function createEnv(): Env {
  return {
    AI: {} as Env["AI"],
    SECURE_API: {
      fetch: async () => new Response(JSON.stringify({ success: true })),
    } as Env["SECURE_API"],
    BYOK_DB: {} as Env["BYOK_DB"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "http://localhost:5173",
    INTERNAL_RUNTIME_EVENT_SECRET: SECRET,
    SESSIONS: {} as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: {} as Env["RUN_ENGINE_RUNTIME"],
  };
}
