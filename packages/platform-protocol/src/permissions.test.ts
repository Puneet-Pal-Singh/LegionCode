import { describe, expect, it } from "vitest";
import { PermissionPolicyDecisionSchema } from "./permissions.js";

const baseDecision = {
  permissionProfileId: "perm_workspace01",
  action: "shell.execute",
  resource: "pnpm test",
  reason: "The command executes within the workspace.",
  riskLevel: "medium",
  redactions: ["env.OPENAI_API_KEY"],
  source: "workspace_policy",
  evaluatedAt: "2026-06-09T12:00:00.000Z",
} as const;

describe("PermissionPolicyDecisionSchema", () => {
  it("requires an approval prompt for ask decisions", () => {
    const decision = PermissionPolicyDecisionSchema.parse({
      ...baseDecision,
      effect: "ask",
      approvalPrompt: "Allow this command?",
    });

    expect(decision.effect).toBe("ask");
  });

  it("rejects ask decisions without an approval prompt", () => {
    expect(() =>
      PermissionPolicyDecisionSchema.parse({
        ...baseDecision,
        effect: "ask",
        approvalPrompt: null,
      }),
    ).toThrow();
  });

  it("keeps approval prompts out of terminal policy decisions", () => {
    expect(() =>
      PermissionPolicyDecisionSchema.parse({
        ...baseDecision,
        effect: "deny",
        approvalPrompt: "This should never be shown.",
      }),
    ).toThrow();
  });
});
