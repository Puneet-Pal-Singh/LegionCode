import {
  EVENT_SCHEMA_VERSION,
  ArtifactEventSchema,
  type ArtifactEvent,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { projectArtifactMetadataEvent } from "./types.js";

const timestamp = "2026-06-09T12:00:00.000Z";

describe("artifact metadata projection", () => {
  it("maps artifact.created events into canonical metadata records", () => {
    for (const kind of ["command_log", "diff", "context_checkpoint"]) {
      const record = projectArtifactMetadataEvent(createArtifactEvent(kind));

      expect(record.kind).toBe(kind);
      expect(record.payloadRef.sizeBytes).toBe(512);
      expect(record.sourceEventId).toBe("evt_artifact01");
      expect(record.projectionVersion).toBe(1);
    }
  });

  it("rejects artifact events with invalid payload checksums", () => {
    expect(() =>
      ArtifactEventSchema.parse({
        ...createArtifactEvent("diff"),
        payload: {
          itemId: null,
          artifact: {
            ...createArtifactEvent("diff").payload.artifact,
            payloadRef: {
              ...createArtifactEvent("diff").payload.artifact.payloadRef,
              sha256: "bad",
            },
          },
        },
      }),
    ).toThrow();
  });
});

function createArtifactEvent(kind: string): ArtifactEvent {
  return ArtifactEventSchema.parse({
    eventId: "evt_artifact01",
    threadId: "thr_abc123",
    runId: "run_abc123",
    workspaceId: "wrk_abc123",
    scopeType: "artifact",
    scopeId: "art_abc123",
    sequence: 1,
    cursor: "cursor_abc123",
    idempotencyKey: `artifact:${kind}`,
    createdAt: timestamp,
    producer: {
      kind: "runtime_kernel",
      id: "kernel",
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    type: "artifact.created",
    payload: {
      itemId: null,
      artifact: {
        artifactId: "art_abc123",
        threadId: "thr_abc123",
        runId: "run_abc123",
        workspaceId: "wrk_abc123",
        itemId: null,
        kind,
        label: kind,
        payloadRef: {
          backend: "r2",
          objectKey: `artifacts/run_abc123/${kind}`,
          uri: null,
          contentType: "application/octet-stream",
          sizeBytes: 512,
          sha256: "d".repeat(64),
        },
        changedFiles: [],
        metadata: {},
        createdAt: timestamp,
        eventSequence: 1,
      },
    },
  });
}
