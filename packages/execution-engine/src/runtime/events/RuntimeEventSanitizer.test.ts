import { describe, expect, it } from "vitest";
import {
  sanitizeRuntimeEventText,
  sanitizeRuntimeEventValue,
} from "./RuntimeEventSanitizer.js";

describe("RuntimeEventSanitizer", () => {
  it("redacts nested credential values without removing safe tool context", () => {
    expect(
      sanitizeRuntimeEventValue({
        command: "git status --short",
        headers: { authorization: "Bearer provider-secret-value" },
        githubToken: "ghp_1234567890abcdef",
      }),
    ).toEqual({
      command: "git status --short",
      headers: { authorization: "[REDACTED]" },
      githubToken: "[REDACTED]",
    });
  });

  it("redacts credentials embedded in command output", () => {
    const value =
      "curl -H 'Authorization: Bearer provider-secret-value' https://example.test";

    expect(sanitizeRuntimeEventText(value)).not.toContain(
      "provider-secret-value",
    );
    expect(sanitizeRuntimeEventText(value)).toContain("[REDACTED]");
  });
});
