import { describe, expect, it } from "vitest";
import { ItemIdSchema } from "@repo/platform-protocol";
import { mapWorkerResultEvents } from "./WorkerResultEventMapper.js";
import { run, timestamp } from "./test-fixtures.js";

const itemId = ItemIdSchema.parse("itm_runtime001");

describe("worker result event mapper", () => {
  it("maps command stdout and stderr into output deltas", () => {
    const projection = mapWorkerResultEvents(run, itemId, {
      exitCode: 1,
      stdout: "build output",
      stderr: "build error",
      durationMs: 120,
      timedOut: false,
      signal: null,
    });

    expect(projection.outputDeltas).toEqual(["build output", "build error"]);
    expect(projection.artifacts).toEqual([]);
  });

  it("projects artifact-store metadata without payload bytes", () => {
    const projection = mapWorkerResultEvents(run, itemId, {
      artifact: {
        artifactId: "art_runtime001",
        kind: "command_log",
        ownership: {
          createdBy: run.userId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
        },
        visibility: "run",
        payload: {
          backend: "memory",
          storageKey: "artifacts/run_runtime001/command.log",
          contentType: "text/plain",
          byteSize: 12,
          sha256: "a".repeat(64),
        },
        properties: {
          label: "Command log",
          workspacePath: "logs/command.log",
        },
        createdAt: timestamp,
      },
    });

    expect(projection.artifacts).toHaveLength(1);
    expect(projection.artifacts[0]).toMatchObject({
      artifactId: "art_runtime001",
      itemId,
      label: "Command log",
      payloadRef: {
        backend: "local_blob",
        objectKey: "artifacts/run_runtime001/command.log",
        contentType: "text/plain",
        sizeBytes: 12,
        sha256: "a".repeat(64),
      },
      metadata: {
        source: "artifact_store",
        visibility: "run",
        workspacePath: "logs/command.log",
      },
    });
    expect(projection.artifacts[0]?.payloadRef).not.toHaveProperty("content");
  });

  it("honors explicit worker event hints", () => {
    const projection = mapWorkerResultEvents(
      run,
      itemId,
      { ok: true },
      [{ type: "tool_output_delta", delta: "streamed output" }],
    );

    expect(projection.outputDeltas).toEqual(["streamed output"]);
  });
});
