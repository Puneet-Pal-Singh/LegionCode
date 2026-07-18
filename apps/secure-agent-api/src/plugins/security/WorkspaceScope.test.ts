import { describe, expect, it } from "vitest";
import type { PluginExecutionContext } from "../../interfaces/types";
import { resolveScopedWorkspaceRoot } from "./WorkspaceScope";

function context(root: string, runId = "run-1"): PluginExecutionContext {
  return {
    workspaceScope: {
      root,
      runId,
      workspaceId: "workspace-1",
      threadId: "thread-1",
      turnId: "turn-1",
      runAttemptId: "attempt-1",
    },
  };
}

describe("resolveScopedWorkspaceRoot", () => {
  it("accepts a server-owned task checkout root", () => {
    expect(
      resolveScopedWorkspaceRoot(
        context("/home/sandbox/checkouts/checkout-1"),
        "run-1",
      ),
    ).toBe("/home/sandbox/checkouts/checkout-1");
  });

  it("rejects broad and non-canonical filesystem roots", () => {
    expect(() => resolveScopedWorkspaceRoot(context("/"), "run-1")).toThrow(
      /Invalid server-issued workspace root/,
    );
    expect(() =>
      resolveScopedWorkspaceRoot(context("/tmp/untrusted"), "run-1"),
    ).toThrow(/Invalid server-issued workspace root/);
  });

  it("rejects a run id outside the server-issued scope", () => {
    expect(() =>
      resolveScopedWorkspaceRoot(
        context("/home/sandbox/checkouts/run-1"),
        "run-2",
      ),
    ).toThrow(/does not match/);
  });

  it("rejects the removed legacy run-derived root", () => {
    expect(() =>
      resolveScopedWorkspaceRoot(
        context("/home/sandbox/runs/run-1"),
        "run-1",
      ),
    ).toThrow(/Invalid server-issued workspace root/);
  });
});
