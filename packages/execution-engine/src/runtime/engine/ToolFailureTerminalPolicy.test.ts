import { describe, expect, it } from "vitest";
import { isTerminalToolFailure } from "./ToolFailureTerminalPolicy.js";

describe("ToolFailureTerminalPolicy", () => {
  it("keeps validation failures recoverable so the model can correct its tool call", () => {
    expect(
      isTerminalToolFailure({
        toolName: "multi_edit",
        error: "multi_edit cannot target the same path more than once",
        failureCode: "validation_failed",
      }),
    ).toBe(false);
  });

  it("recognizes the duplicate multi-edit target error without a structured code", () => {
    expect(
      isTerminalToolFailure({
        toolName: "multi_edit",
        error: "multi_edit cannot target the same path more than once",
      }),
    ).toBe(false);
  });

  it("keeps unknown mutating tool failures terminal", () => {
    expect(
      isTerminalToolFailure({
        toolName: "edit_file",
        error: "workspace write failed unexpectedly",
      }),
    ).toBe(true);
  });
});
