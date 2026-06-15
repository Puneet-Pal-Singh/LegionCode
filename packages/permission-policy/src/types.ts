import {
  PermissionEffectSchema,
  PermissionRiskLevelSchema,
  type PermissionEffect,
  type PermissionRiskLevel,
} from "@repo/platform-protocol";
import { z } from "zod";

export {
  PermissionEffectSchema,
  PermissionRiskLevelSchema,
  type PermissionEffect,
  type PermissionRiskLevel,
};

export const PolicyDomainSchema = z.enum([
  "command",
  "path",
  "network",
  "git",
  "package_manager",
  "secret",
  "external_service",
  "tool",
]);
export type PolicyDomain = z.infer<typeof PolicyDomainSchema>;

export const PermissionRuleSchema = z
  .object({
    id: z.string().min(1).max(160),
    pattern: z.string().min(1).max(2_000),
    effect: PermissionEffectSchema,
    reason: z.string().min(1).max(2_000).optional(),
    riskLevel: PermissionRiskLevelSchema.optional(),
    approvalPrompt: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const RuleSetPolicySchema = z
  .object({
    defaultEffect: PermissionEffectSchema,
    defaultRiskLevel: PermissionRiskLevelSchema,
    rules: z.array(PermissionRuleSchema),
  })
  .strict();
export type RuleSetPolicy = z.infer<typeof RuleSetPolicySchema>;

export const PermissionPolicySchema = z
  .object({
    commands: RuleSetPolicySchema,
    paths: RuleSetPolicySchema,
    network: RuleSetPolicySchema,
    git: RuleSetPolicySchema,
    packageManagers: RuleSetPolicySchema,
    secrets: RuleSetPolicySchema,
    externalServices: RuleSetPolicySchema,
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
      domain: z.literal("package_manager"),
      manager: SubjectSchema,
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
      domain: z.literal("external_service"),
      service: SubjectSchema,
      operation: SubjectSchema,
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
  riskLevel: PermissionRiskLevel;
  matchedRule: MatchedRule | null;
};

export type ApprovalRequest = {
  prompt: string;
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
