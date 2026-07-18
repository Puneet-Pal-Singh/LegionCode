import { describe, expect, it } from "vitest";
import { createSandboxId, createSandboxLease } from "./SandboxExecutionLease";

const workspaceScope = {
  runId: "run_013004cdd3a14b43919e368b383fc4ab",
  threadId: "thr_123e4567-e89b-42d3-a456-426614174000",
  turnId: "trn_123e4567-e89b-42d3-a456-426614174000",
  runAttemptId: "attempt_123e4567-e89b-42d3-a456-426614174001",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  root: "/workspace",
};

describe("SandboxExecutionLease", () => {
  it("uses a deterministic Cloudflare-compatible ID for UUID-backed scopes", async () => {
    const first = await createSandboxLease({
      workspaceScope,
      owner: "session-1",
      correlationId: "correlation-1",
      now: 1,
    });
    const second = await createSandboxLease({
      workspaceScope,
      owner: "session-2",
      correlationId: "correlation-2",
      now: 2,
    });

    expect(first.sandboxId).toBe(second.sandboxId);
    expect(first.sandboxId).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(first.sandboxId.length).toBeLessThanOrEqual(63);
    expect(first.sandboxId).toBe(
      await createSandboxId(
        workspaceScope.workspaceId,
        workspaceScope.runAttemptId,
      ),
    );
  });

  it("keeps distinct run attempts in separate sandboxes", async () => {
    expect(
      await createSandboxId(
        workspaceScope.workspaceId,
        workspaceScope.runAttemptId,
      ),
    ).not.toBe(
      await createSandboxId(
        workspaceScope.workspaceId,
        "attempt_223e4567-e89b-42d3-a456-426614174001",
      ),
    );
  });
});
