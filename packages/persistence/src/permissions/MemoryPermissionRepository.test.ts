import { describe, expect, it } from "vitest";
import { MemoryPermissionRepository } from "./MemoryPermissionRepository.js";
import {
  PERMISSION_DECISION_KINDS,
  PERMISSION_REQUEST_STATUSES,
} from "./types.js";

describe("MemoryPermissionRepository", () => {
  const mockClock = { now: () => new Date("2025-01-01T00:00:00Z") };

  it("should create request and list by run", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const request = await repo.createRequest({
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      requestType: "shell_command",
    });

    expect(request.id).toBeTruthy();
    expect(request.status).toBe("pending");

    const requests = await repo.listRequestsByRun("run-1");
    expect(requests).toHaveLength(1);
  });

  it("should create decision and list by request", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const request = await repo.createRequest({
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      requestType: "shell_command",
    });

    const decision = await repo.createDecision({
      permissionRequestId: request.id,
      userId: "user-1",
      decision: "allow_once",
    });

    expect(decision.id).toBeTruthy();
    expect(decision.decision).toBe("allow_once");

    const decisions = await repo.listDecisionsByRequest(request.id);
    expect(decisions).toHaveLength(1);

    const resolvedRequests = await repo.listRequestsByRun("run-1");
    expect(resolvedRequests[0]?.status).toBe("resolved");
    expect(resolvedRequests[0]?.resolvedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("should mark aborted requests when the decision aborts", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const request = await repo.createRequest({
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      requestType: "shell_command",
    });

    await repo.createDecision({
      permissionRequestId: request.id,
      userId: "user-1",
      decision: "abort",
    });

    const requests = await repo.listRequestsByRun("run-1");
    expect(requests[0]?.status).toBe("aborted");
  });

  it("should scope decisions by request owner", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const request = await repo.createRequest({
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      requestType: "shell_command",
    });
    await repo.createDecision({
      permissionRequestId: request.id,
      userId: "user-1",
      decision: "allow_once",
    });

    expect(await repo.listDecisionsByRequest(request.id, "user-1")).toHaveLength(1);
    expect(await repo.listDecisionsByRequest(request.id, "user-2")).toHaveLength(0);
  });

  it("should reject decisions for another user's request", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const request = await repo.createRequest({
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      requestType: "shell_command",
    });

    await expect(
      repo.createDecision({
        permissionRequestId: request.id,
        userId: "user-2",
        decision: "allow_once",
      }),
    ).rejects.toThrow(`Permission request not found: ${request.id}`);
  });

  it("should not expose mutable request or decision state", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const request = await repo.createRequest({
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      requestType: "shell_command",
      payload: { command: "pnpm test" },
    });
    const decision = await repo.createDecision({
      permissionRequestId: request.id,
      userId: "user-1",
      decision: "allow_once",
      payload: { reason: "test" },
    });

    request.requestType = "mutated";
    request.payload = { command: "rm -rf" };
    decision.decision = "deny";
    decision.payload = { reason: "mutated" };

    const requests = await repo.listRequestsByRun("run-1");
    const decisions = await repo.listDecisionsByRequest(request.id);
    expect(requests[0]?.requestType).toBe("shell_command");
    expect(requests[0]?.payload).toEqual({ command: "pnpm test" });
    expect(decisions[0]?.decision).toBe("allow_once");
    expect(decisions[0]?.payload).toEqual({ reason: "test" });
  });

  it("should roll back in-memory transaction changes on failure", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    await expect(
      repo.transaction(async (txRepo) => {
        await txRepo.createRequest({
          userId: "user-1",
          sessionId: "session-1",
          runId: "run-1",
          requestType: "shell_command",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await repo.listRequestsByRun("run-1")).toHaveLength(0);
  });

  it("should support transaction", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const result = await repo.transaction(async (txRepo) => {
      return await txRepo.createRequest({
        userId: "user-1",
        sessionId: "session-1",
        runId: "run-1",
        requestType: "shell_command",
      });
    });

    expect(result.id).toBeTruthy();
  });

  it("should reject invalid permission request status", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    await expect(
      repo.createRequest({
        userId: "user-1",
        sessionId: "session-1",
        runId: "run-1",
        requestType: "shell_command",
        status: "invalid_status",
      }),
    ).rejects.toThrow("Unsupported permission request status: invalid_status");
  });

  it("should accept all valid permission request statuses", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    for (const status of PERMISSION_REQUEST_STATUSES) {
      const request = await repo.createRequest({
        userId: "user-1",
        sessionId: "session-1",
        runId: "run-1",
        requestType: "shell_command",
        status,
      });
      expect(request.status).toBe(status);
    }
  });

  it("should accept all valid permission decision kinds", async () => {
    const repo = new MemoryPermissionRepository(mockClock);

    const request = await repo.createRequest({
      userId: "user-1",
      sessionId: "session-1",
      runId: "run-1",
      requestType: "shell_command",
    });

    for (const decision of PERMISSION_DECISION_KINDS) {
      const record = await repo.createDecision({
        permissionRequestId: request.id,
        userId: "user-1",
        decision,
      });
      expect(record.decision).toBe(decision);
    }
  });
});
