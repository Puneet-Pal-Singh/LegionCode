import { describe, expect, it } from "vitest";
import {
  classifyWriteFilePreflightFailure,
  resolveWriteFileExpectedSha256,
} from "./WriteFilePrecondition.js";

describe("WriteFilePrecondition", () => {
  it("only treats explicit missing-target failures as file creation", () => {
    expect(classifyWriteFilePreflightFailure("File not found")).toEqual({
      kind: "missing",
    });
    expect(classifyWriteFilePreflightFailure("read timed out")).toEqual({
      kind: "error",
      message: "read timed out",
    });
  });

  it("rejects a write when the existing target could not be verified", () => {
    expect(() =>
      resolveWriteFileExpectedSha256(
        { kind: "error", message: "permission denied" },
        "0".repeat(64),
      ),
    ).toThrow(/Unable to verify write target/);
  });
});
