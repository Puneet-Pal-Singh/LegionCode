import { describe, expect, it } from "vitest";
import { toSecureExecutionWorkspaceScope } from "./RuntimeWorkspaceScope";

const identity = {
  runId: "run_scope_test",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session_scope_test",
  threadId: "thr_scope_test",
  turnId: "trn_scope_test",
  runAttemptId: "attempt_scope_test",
};

describe("RuntimeWorkspaceScope", () => {
  it("projects the persisted checkout root into the secure execution scope", () => {
    expect(
      toSecureExecutionWorkspaceScope({
        ...identity,
        root: "/home/sandbox/checkouts/checkout_123456",
      }),
    ).toEqual({
      runId: identity.runId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      runAttemptId: identity.runAttemptId,
      workspaceId: "wrk_00000000-0000-4000-8000-000000000001",
      root: "/home/sandbox/checkouts/checkout_123456",
    });
  });
});
