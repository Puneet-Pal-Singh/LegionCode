import { describe, expect, it } from "vitest";
import { ValidationError } from "../domain/errors";
import { extractIdentifiers } from "./chat-request-helpers";

describe("extractIdentifiers", () => {
  it("accepts canonical run identifiers", () => {
    expect(
      extractIdentifiers({
        sessionId: "session-123",
        runId: "run_9e2b57d829fe453fbcc88135589fbe54",
      }),
    ).toEqual({
      sessionId: "session-123",
      runId: "run_9e2b57d829fe453fbcc88135589fbe54",
    });
  });

  it("rejects legacy UUID run identifiers", () => {
    expect(() =>
      extractIdentifiers({
        sessionId: "session-123",
        runId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).toThrow(ValidationError);
  });
});
