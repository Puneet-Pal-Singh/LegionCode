import { describe, expect, it } from "vitest";
import {
  ArtifactKindSchema,
  ArtifactMetadataSchema,
  ArtifactPayloadRefSchema,
  TurnDiffPayloadSchema,
} from "./artifacts.js";

const timestamp = "2026-06-08T15:00:00.000Z";

describe("artifact protocol schemas", () => {
  it("accepts generalized rebuild artifact kinds", () => {
    expect(ArtifactKindSchema.options).toContain("command_log");
    expect(ArtifactKindSchema.options).toContain("diff");
    expect(ArtifactKindSchema.options).toContain("context_checkpoint");
  });

  it("requires checksum and size in payload references", () => {
    const payloadRef = ArtifactPayloadRefSchema.parse({
      backend: "r2",
      objectKey: "artifacts/run_abc123/command.log",
      uri: null,
      contentType: "text/plain",
      sizeBytes: 42,
      sha256: "b".repeat(64),
    });

    expect(payloadRef.sizeBytes).toBe(42);
    expect(() =>
      ArtifactPayloadRefSchema.parse({
        ...payloadRef,
        sha256: "not-a-checksum",
      }),
    ).toThrow();
  });

  it("accepts command log, diff, and context checkpoint metadata", () => {
    for (const kind of ["command_log", "diff", "context_checkpoint"]) {
      const artifact = ArtifactMetadataSchema.parse({
        artifactId: `art_${kind.replaceAll("_", "")}123`,
        threadId: "thr_abc123",
        runId: "run_abc123",
        workspaceId: "wrk_abc123",
        itemId: null,
        kind,
        label: kind,
        payloadRef: {
          backend: "local_blob",
          objectKey: `runs/run_abc123/${kind}`,
          uri: null,
          contentType: "application/octet-stream",
          sizeBytes: 1,
          sha256: "c".repeat(64),
        },
        changedFiles: [],
        metadata: {},
        createdAt: timestamp,
        eventSequence: 1,
      });

      expect(artifact.kind).toBe(kind);
    }
  });

  it("requires one turn identity across immutable diff snapshots", () => {
    const snapshot = {
      turnId: "trn_artifact001",
      snapshotKey: "trn_artifact001",
      treeId: "a".repeat(40),
      headSha: "b".repeat(40),
      phase: "start",
      capturedAt: timestamp,
    };
    expect(
      TurnDiffPayloadSchema.parse({
        turnId: snapshot.turnId,
        startSnapshot: snapshot,
        terminalSnapshot: {
          ...snapshot,
          phase: "terminal",
          treeId: "c".repeat(40),
        },
        files: [],
        patch: "",
      }).files,
    ).toEqual([]);
    expect(() =>
      TurnDiffPayloadSchema.parse({
        turnId: snapshot.turnId,
        startSnapshot: snapshot,
        terminalSnapshot: {
          ...snapshot,
          turnId: "trn_artifact002",
          phase: "terminal",
        },
        files: [],
        patch: "",
      }),
    ).toThrow();
  });
});
