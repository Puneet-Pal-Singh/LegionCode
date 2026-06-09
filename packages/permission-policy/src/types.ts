import { z } from "zod";

export const PermissionEffectSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

export const PolicyDomainSchema = z.enum([
  "command",
  "path",
  "network",
  "git",
  "secret",
  "tool",
]);
export type PolicyDomain = z.infer<typeof PolicyDomainSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PermissionRuleSchema = z
  .object({
    id: z.string().min(1).max(160),
    pattern: z.string().min(1).max(2_000),
    effect: PermissionEffectSchema,
    reason: z.string().min(1).max(2_000).optional(),
    riskLevel: RiskLevelSchema.optional(),
    approvalPrompt: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const RuleSetPolicySchema = z
  .object({
    defaultEffect: PermissionEffectSchema,
    rules: z.array(PermissionRuleSchema),
  })
  .strict();
export type RuleSetPolicy = z.infer<typeof RuleSetPolicySchema>;

export const NetworkPolicySchema = RuleSetPolicySchema.extend({
  allowLocalNetwork: z.boolean(),
}).strict();
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export const PermissionPolicySchema = z
  .object({
    defaultEffect: PermissionEffectSchema,
    commands: RuleSetPolicySchema,
    paths: RuleSetPolicySchema,
    network: NetworkPolicySchema,
    git: RuleSetPolicySchema,
    secrets: RuleSetPolicySchema,
    tools: RuleSetPolicySchema,
  })
  .strict();
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

const SubjectSchema = z.string().min(1).max(4_000);

export const PermissionRequestSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("command"), command: SubjectSchema }).strict(),
  z
    .object({
      domain: z.literal("path"),
      path: SubjectSchema,
      operation: z.enum(["read", "write", "delete", "list"]),
    })
    .strict(),
  z
    .object({
      domain: z.literal("network"),
      url: SubjectSchema,
      operation: z.enum(["connect", "fetch"]),
    })
    .strict(),
  z
    .object({
      domain: z.literal("git"),
      operation: SubjectSchema,
    })
    .strict(),
  z
    .object({
      domain: z.literal("secret"),
      secretRef: SubjectSchema,
      operation: z.enum(["read", "write", "use", "reveal"]),
    })
    .strict(),
  z
    .object({
      domain: z.literal("tool"),
      toolName: SubjectSchema,
      action: SubjectSchema.optional(),
    })
    .strict(),
]);
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export type MatchedRule = Pick<
  PermissionRule,
  "id" | "pattern" | "effect" | "reason" | "riskLevel"
>;

type DecisionBase = {
  domain: PolicyDomain;
  subject: string;
  reason: string;
  riskLevel: RiskLevel;
  matchedRule: MatchedRule | null;
};

export type ApprovalRequest = {
  prompt: string;
  suggestedRules: readonly PermissionRule[];
};

export type PolicyDecisionResult =
  | (DecisionBase & { effect: "allow"; approval: null })
  | (DecisionBase & { effect: "ask"; approval: ApprovalRequest })
  | (DecisionBase & { effect: "deny"; approval: null });

export function parsePermissionPolicy(input: unknown): PermissionPolicy {
  return PermissionPolicySchema.parse(input);
}

export function parsePermissionRequest(input: unknown): PermissionRequest {
  return PermissionRequestSchema.parse(input);
}
