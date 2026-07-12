import { describe, expect, it } from "vitest";
import {
  assertCanonicalRunAdmissionIdentity,
  buildAdmissionPolicy,
} from "./RunAdmissionPolicy";

describe("RunAdmissionPolicy", () => {
  it("keeps different threads concurrent while sharing the workspace bucket", () => {
    const first = buildAdmissionPolicy(
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        runAttemptId: "run-1",
        mode: "build",
        workflowIntent: "build",
      },
      {},
    );
    const second = buildAdmissionPolicy(
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        threadId: "thread-2",
        runAttemptId: "run-2",
        mode: "build",
        workflowIntent: "build",
      },
      {},
    );

    expect(first.concurrencyConstraints[0]?.scopeKey).toBe("thread:thread-1");
    expect(second.concurrencyConstraints[0]?.scopeKey).toBe("thread:thread-2");
    expect(first.concurrencyConstraints[2]).toEqual(
      second.concurrencyConstraints[2],
    );
  });

  it("does not replace missing canonical identity with a fingerprint", () => {
    expect(() =>
      assertCanonicalRunAdmissionIdentity(
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          runAttemptId: "run-1",
        },
        "corr-1",
      ),
    ).toThrowError(/Canonical userId is required/);
  });
});
