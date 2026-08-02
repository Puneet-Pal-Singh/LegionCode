import { describe, expect, it } from "vitest";
import {
  TurnScopeBootstrapRequestSchema,
  TurnScopeBootstrapSchema,
} from "./turn-scope-bootstrap.js";

const REQUEST = {
  runId: "run_123456",
  sessionId: "session-1",
  clientMessageId: "client-message-1",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  correlationId: "corr-1",
};

describe("turn scope bootstrap protocol", () => {
  it("requires the server-owned request scope and returns all four identities", () => {
    expect(TurnScopeBootstrapRequestSchema.parse(REQUEST)).toEqual(REQUEST);
    expect(
      TurnScopeBootstrapSchema.parse({
        workspaceId: REQUEST.workspaceId,
        threadId: "thr_123456",
        turnId: "trn_123456",
        runAttemptId: "attempt_123456",
      }),
    ).toMatchObject({
      workspaceId: REQUEST.workspaceId,
      threadId: "thr_123456",
      turnId: "trn_123456",
      runAttemptId: "attempt_123456",
    });
  });

  it("rejects client-shaped or prompt-shaped identity values", () => {
    expect(() =>
      TurnScopeBootstrapSchema.parse({
        workspaceId: REQUEST.workspaceId,
        threadId: "thread-from-prompt",
        turnId: "turn-from-latest-message",
        runAttemptId: "run-only-cache",
      }),
    ).toThrow();
  });
});
