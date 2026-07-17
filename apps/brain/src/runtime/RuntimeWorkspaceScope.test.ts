import { describe, expect, it } from "vitest";
import {
  canonicalRuntimeWorkspaceRoot,
  toRuntimeWorkspaceScope,
  toSecureExecutionWorkspaceScope,
} from "./RuntimeWorkspaceScope";

const identity = {
  runId: "run_scope_test",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session_scope_test",
  threadId: "thr_scope_test",
  turnId: "trn_scope_test",
  runAttemptId: "attempt_scope_test",
};

describe("RuntimeWorkspaceScope", () => {
  it("derives the canonical run workspace root", () => {
    expect(canonicalRuntimeWorkspaceRoot(identity.runId)).toBe(
      "/home/sandbox/runs/run_scope_test",
    );
  });

  it("projects server-issued turn identity with the canonical root", () => {
    expect(toRuntimeWorkspaceScope(identity)).toMatchObject({
      ...identity,
      root: "/home/sandbox/runs/run_scope_test",
    });
  });

  it("projects the canonical secure execution scope", () => {
    expect(
      toSecureExecutionWorkspaceScope({
        ...toRuntimeWorkspaceScope(identity),
      }),
    ).toEqual({
      runId: identity.runId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      runAttemptId: identity.runAttemptId,
      workspaceId: identity.workspaceId,
      root: "/home/sandbox/runs/run_scope_test",
    });
  });
});
