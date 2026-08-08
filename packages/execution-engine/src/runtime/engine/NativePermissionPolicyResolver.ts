import type { ProductMode } from "@repo/shared-types";
import type {
  PermissionPolicy,
  RuleSetPolicy,
} from "@repo/permission-policy";

export class NativePermissionPolicyResolver {
  constructor(private readonly productMode: ProductMode) {}

  async resolve(): Promise<PermissionPolicy> {
    const allowLow = ruleSet("allow", "low");
    const askHigh = ruleSet("ask", "high");
    const tools =
      this.productMode === "ask_always"
        ? ruleSet(
            "allow",
            "low",
            ["write_file", "edit_file", "multi_edit", "apply_patch", "format_file"].map(
              (toolName) => ({
                id: `supervised-${toolName}`,
                pattern: toolName,
                effect: "ask" as const,
                riskLevel: "high" as const,
                reason: "Supervised mode requires confirmation for workspace changes.",
                approvalPrompt: "Allow this workspace file change?",
              }),
            ),
          )
        : allowLow;

    return {
      commands: askHigh,
      paths: allowLow,
      network: askHigh,
      git: askHigh,
      packageManagers: askHigh,
      secrets: ruleSet("deny", "critical"),
      externalServices: askHigh,
      tools,
    };
  }
}

function ruleSet(
  defaultEffect: RuleSetPolicy["defaultEffect"],
  defaultRiskLevel: RuleSetPolicy["defaultRiskLevel"],
  rules: RuleSetPolicy["rules"] = [],
): RuleSetPolicy {
  return { defaultEffect, defaultRiskLevel, rules };
}
