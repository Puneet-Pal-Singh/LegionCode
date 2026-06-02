import { describe, expect, it, vi } from "vitest";
import { parseRunSummaryStatusSnapshot } from "./run-summary-status-snapshot";

describe("parseRunSummaryStatusSnapshot", () => {
  it("returns approval state for valid pending approval payloads", () => {
    const snapshot = parseRunSummaryStatusSnapshot({
      status: "PAUSED",
      pendingApproval: {
        requestId: "approval-1",
        runId: "run-1",
        origin: "agent",
        category: "shell_command",
        title: "Run command",
        reason: "Needs approval",
        command: "git status",
        actionFingerprint: "fingerprint-1",
        availableDecisions: ["allow_once", "deny"],
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    });

    expect(snapshot).toEqual({
      status: "PAUSED",
      hasPendingApproval: true,
    });
  });

  it("rejects malformed pending approval payloads", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const snapshot = parseRunSummaryStatusSnapshot({
      status: "PAUSED",
      pendingApproval: { requestId: "approval-1" },
    });

    expect(snapshot).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[run/summary] Invalid status snapshot payload",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("keeps terminal snapshots without pending approvals", () => {
    const snapshot = parseRunSummaryStatusSnapshot({
      status: "COMPLETED",
      pendingApproval: null,
    });

    expect(snapshot).toEqual({
      status: "COMPLETED",
      hasPendingApproval: false,
    });
  });
});
