import { describe, expect, it } from "vitest";
import { findLastMatchingRule, matchesWildcardPattern } from "./patterns.js";

describe("matchesWildcardPattern", () => {
  it("supports simple wildcard rules", () => {
    expect(matchesWildcardPattern("git *", "git status --short")).toBe(true);
    expect(matchesWildcardPattern("git ?", "git status")).toBe(false);
  });

  it("treats later matching rules as the winner", () => {
    const rule = findLastMatchingRule(
      [
        { id: "default", pattern: "git *", effect: "allow" },
        { id: "push", pattern: "git push*", effect: "deny" },
      ],
      "git push origin main",
    );

    expect(rule?.id).toBe("push");
    expect(rule?.effect).toBe("deny");
  });
});
