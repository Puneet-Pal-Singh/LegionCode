import { describe, expect, it } from "vitest";
import { MemoryRuntimeEventInboxRepository } from "@repo/persistence";
import {
  INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER,
  INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER,
} from "@repo/shared-types";
import { RuntimeEventIngestionService } from "./RuntimeEventIngestionService";
import { RuntimeEventSignatureVerifier } from "./RuntimeEventSignatureVerifier";

const NOW = 1778630400000;
const SECRET = "runtime-event-secret";

describe("RuntimeEventIngestionService", () => {
  it("verifies, validates, and dedupes signed runtime events", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
    const verifier = new RuntimeEventSignatureVerifier(SECRET, () => NOW);
    const service = new RuntimeEventIngestionService(repository, verifier);
    const rawBody = JSON.stringify({
      source: "secure-agent-api",
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload: { runId: "run-1" },
    });
    const headers = await signHeaders(verifier, rawBody);

    const first = await service.accept({ rawBody, headers });
    const second = await service.accept({ rawBody, headers });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
  });

  it("rejects unsigned body tampering", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
    const verifier = new RuntimeEventSignatureVerifier(SECRET, () => NOW);
    const service = new RuntimeEventIngestionService(repository, verifier);
    const rawBody = JSON.stringify({
      source: "secure-agent-api",
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload: { runId: "run-1" },
    });
    const headers = await signHeaders(verifier, rawBody);

    await expect(
      service.accept({
        rawBody: rawBody.replace("run-1", "run-2"),
        headers,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUNTIME_EVENT_SIGNATURE" });
  });
});

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
