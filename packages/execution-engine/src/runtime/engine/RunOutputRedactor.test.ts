import { describe, expect, it } from "vitest";
import { redactUserFacingOutput } from "./RunOutputRedactor.js";

describe("RunOutputRedactor", () => {
  it("redacts internal runtime paths and internal URLs in user-facing output", () => {
    const output = redactUserFacingOutput(
      "cat: /home/sandbox/runs/5212f17b-eb1f-463f-a41f-2c4c6b9d4ba6/README.md: No such file or directory\nSee https://internal/debug",
    );

    expect(output).not.toContain(
      "/home/sandbox/runs/5212f17b-eb1f-463f-a41f-2c4c6b9d4ba6/",
    );
    expect(output).toContain(
      "The requested file was not found in the current workspace.",
    );
    expect(output).toContain("[internal-url]");
  });

  it("does not repair or remove model-authored final-answer prose", () => {
    const output = redactUserFacingOutput(
      "The user asked me to check PR #58. I found the issue in Footer.tsx.",
    );

    expect(output).toBe(
      "The user asked me to check PR #58. I found the issue in Footer.tsx.",
    );
  });
});
