import { describe, expect, it } from "vitest";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
  mapRunStatusToSessionStatus,
  normalizeRunStatus,
} from "./run-status";

describe("run status helpers", () => {
  it("normalizes postgres lowercase terminal statuses", () => {
    expect(normalizeRunStatus("completed")).toBe("COMPLETED");
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(mapRunStatusToSessionStatus("completed")).toBe("completed");
  });

  it("maps failure terminal statuses to a failed session state", () => {
    expect(mapRunStatusToSessionStatus("failed")).toBe("failed");
    expect(mapRunStatusToSessionStatus("cancelled")).toBe("failed");
  });

  it("treats paused as terminal unless a pending approval is present", () => {
    expect(isTerminalRunStatus("paused")).toBe(true);
    expect(isApprovalRequiredRunStatus("paused")).toBe(false);
    expect(mapRunStatusToSessionStatus("paused")).toBe("paused");
    expect(
      mapRunStatusToSessionStatus("paused", { hasPendingApproval: true }),
    ).toBe("waiting_for_approval");
  });

  it("maps approval waiting states to a waiting approval session state", () => {
    expect(isApprovalRequiredRunStatus("approval_required")).toBe(true);
    expect(isApprovalRequiredRunStatus("waiting")).toBe(false);
    expect(
      mapRunStatusToSessionStatus("completed", { hasPendingApproval: true }),
    ).toBe(
      "waiting_for_approval",
    );
    expect(mapRunStatusToSessionStatus("approval_required")).toBe(
      "waiting_for_approval",
    );
  });
});
