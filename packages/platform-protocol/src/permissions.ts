import { z } from "zod";
import { ProtocolTimestampSchema } from "./common.js";
import { PermissionProfileIdSchema } from "./ids.js";

const PermissionActionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/);

export const PermissionEffectSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

export const PermissionRiskLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export type PermissionRiskLevel = z.infer<
  typeof PermissionRiskLevelSchema
>;

export const PermissionDecisionSourceSchema = z.enum([
  "system_policy",
  "organization_policy",
  "workspace_policy",
  "user_policy",
  "run_policy",
]);
export type PermissionDecisionSource = z.infer<
  typeof PermissionDecisionSourceSchema
>;

export const PermissionPolicyDecisionSchema = z
  .object({
    permissionProfileId: PermissionProfileIdSchema,
    action: PermissionActionSchema,
    resource: z.string().min(1).max(2_000),
    effect: PermissionEffectSchema,
    reason: z.string().min(1).max(2_000),
    riskLevel: PermissionRiskLevelSchema,
    approvalPrompt: z.string().min(1).max(2_000).nullable(),
    redactions: z.array(z.string().min(1).max(200)).max(128),
    source: PermissionDecisionSourceSchema,
    evaluatedAt: ProtocolTimestampSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    const requiresPrompt = decision.effect === "ask";
    const hasPrompt = decision.approvalPrompt !== null;

    if (requiresPrompt !== hasPrompt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvalPrompt"],
        message: "approvalPrompt must be present only for ask decisions",
      });
    }
  });
export type PermissionPolicyDecision = z.infer<
  typeof PermissionPolicyDecisionSchema
>;
