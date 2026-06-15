import type { ZodType } from "zod";
import { describe, expect, it } from "vitest";

export function registerWorkerProtocolConformance(
  implementation: string,
  requestSchema: ZodType,
  responseSchema: ZodType,
  protocolVersion: string | number,
): void {
  describe(`${implementation} worker protocol conformance`, () => {
    it("requires run-scoped requests", () => {
      expect(() =>
        requestSchema.parse({
          requestId: "req-conformance",
          protocolVersion,
          operation: "worker.health",
          payload: {},
        }),
      ).toThrow();
    });

    it("preserves typed error envelopes", () => {
      const response = responseSchema.parse({
        requestId: "req-conformance",
        protocolVersion,
        runId: "run_conformance",
        operation: "git.status",
        ok: false,
        error: {
          code: "git_operation_failed",
          message: "Git status failed",
          retryable: false,
          correlationId: "corr-conformance",
          details: null,
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: "git_operation_failed", retryable: false },
      });
    });
  });
}
