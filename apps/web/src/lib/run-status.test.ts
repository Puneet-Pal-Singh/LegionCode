import { describe, expect, it } from "vitest";
import {
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

  it("treats paused as terminal without mapping it to failure", () => {
    expect(isTerminalRunStatus("paused")).toBe(true);
    expect(mapRunStatusToSessionStatus("paused")).toBe("paused");
  });
});
