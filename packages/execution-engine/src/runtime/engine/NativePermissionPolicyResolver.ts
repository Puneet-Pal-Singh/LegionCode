import type { ProductMode } from "@repo/shared-types";
import type { PermissionPolicy, RuleSetPolicy } from "@repo/permission-policy";

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
            [
              "write_file",
              "edit_file",
              "multi_edit",
              "apply_patch",
              "format_file",
            ].map((toolName) => ({
              id: `supervised-${toolName}`,
              pattern: toolName,
              effect: "ask" as const,
              riskLevel: "high" as const,
              reason:
                "Supervised mode requires confirmation for workspace changes.",
              approvalPrompt: "Allow this workspace file change?",
            })),
          )
        : allowLow;

    // Structured executable calls have no shell command string. Keep them in
    // the tool policy domain with exact-input approval in every product mode.
    const executableTools: RuleSetPolicy = {
      ...tools,
      rules: [
        ...tools.rules,
        {
          id: "native-single-executable-approval",
          pattern: "run_executable",
          effect: "ask",
          riskLevel: "high",
          reason:
            "Running this exact executable and argv requires approval for invoking-user host file, network and IPC access; subprocesses and signals to other PIDs are denied.",
          approvalPrompt:
            "Run this executable with these exact arguments using your macOS user file/network/IPC access, including outside this workspace? Subprocesses and signals to other PIDs are denied.",
        },
      ],
    };
    return {
      commands: askHigh,
      paths: allowLow,
      network: askHigh,
      git: askHigh,
      packageManagers: askHigh,
      secrets: ruleSet("deny", "critical"),
      externalServices: askHigh,
      tools: executableTools,
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
