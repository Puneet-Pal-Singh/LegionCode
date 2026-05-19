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

  it("maps failure terminal statuses to an error session state", () => {
    expect(mapRunStatusToSessionStatus("failed")).toBe("error");
    expect(mapRunStatusToSessionStatus("cancelled")).toBe("error");
  });
});
