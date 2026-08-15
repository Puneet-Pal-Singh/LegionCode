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

  it("rejects a write when the existing target could not be verified", async () => {
    await expect(
      resolveWriteFileExpectedSha256({
        kind: "error",
        message: "permission denied",
      }),
    ).rejects.toThrow(/Unable to verify write target/);
  });

  it("derives the replacement guard from the runtime preflight", async () => {
    await expect(
      resolveWriteFileExpectedSha256({ kind: "present", content: "hello" }),
    ).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
