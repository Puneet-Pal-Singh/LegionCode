import { describe, expect, it } from "vitest";
import {
  WORKER_OPERATION_NAMES,
  WORKER_PROTOCOL_VERSION,
} from "./common.js";
import {
  WorkerProtocolRequestSchema,
  WorkerProtocolResponseSchema,
} from "./protocol.js";

describe("worker protocol envelopes", () => {
  it("keeps the schema operation list stable", () => {
    expect(WORKER_OPERATION_NAMES).toMatchInlineSnapshot(`
      [
        "worker.capabilities",
        "command.run",
        "file.read",
        "file.write",
        "patch.apply",
        "git.status",
        "git.diff",
        "git.stage",
        "git.commit",
        "git.push",
        "artifact.upload",
        "artifact.download",
        "artifact.list",
      ]
    `);
  });

  it("parses a command.run request without execution semantics", () => {
    const request = WorkerProtocolRequestSchema.parse({
      requestId: "req-command-1",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operation: "command.run",
      payload: {
        argv: ["pnpm", "test"],
        cwd: "packages/worker-protocol",
        env: { CI: "true" },
        stdin: null,
        timeoutMs: 30_000,
      },
    });

    expect(request.operation).toBe("command.run");
  });

  it("parses file, patch, git, and artifact request shapes", () => {
    const requests = [
      {
        requestId: "req-file-read",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        operation: "file.read",
        payload: {
          path: "packages/worker-protocol/src/index.ts",
          encoding: "utf8",
          maxBytes: null,
        },
      },
      {
        requestId: "req-file-write",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        operation: "file.write",
        payload: {
          path: "tmp/output.txt",
          encoding: "utf8",
          content: "ok",
          overwrite: true,
          createParents: true,
        },
      },
      {
        requestId: "req-patch",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        operation: "patch.apply",
        payload: {
          unifiedDiff: "diff --git a/a.txt b/a.txt",
          strip: 1,
          reverse: false,
          dryRun: true,
        },
      },
      {
        requestId: "req-git-status",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        operation: "git.status",
        payload: { paths: [] },
      },
      {
        requestId: "req-artifact-list",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        operation: "artifact.list",
        payload: {
          runId: "run_abc123",
          kinds: ["command_log"],
          cursor: null,
          limit: 50,
        },
      },
    ];

    for (const request of requests) {
      expect(WorkerProtocolRequestSchema.parse(request).operation).toBe(
        request.operation,
      );
    }
  });

  it("rejects path traversal in file requests", () => {
    expect(() =>
      WorkerProtocolRequestSchema.parse({
        requestId: "req-path-denied",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        operation: "file.read",
        payload: {
          path: "../secret.txt",
          encoding: "utf8",
          maxBytes: null,
        },
      }),
    ).toThrow();
  });

  it("parses typed worker error responses", () => {
    const response = WorkerProtocolResponseSchema.parse({
      requestId: "req-error",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      operation: "git.push",
      ok: false,
      error: {
        code: "git_operation_failed",
        message: "Git push failed",
        retryable: true,
        correlationId: "corr-123",
        details: { remoteName: "origin" },
      },
    });

    expect(response.ok).toBe(false);
  });
});
