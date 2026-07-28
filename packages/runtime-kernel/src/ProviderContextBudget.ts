import {
  ContextBudgetSnapshotSchema,
  type ContextBudgetSnapshot,
  type UsageCostSnapshot,
} from "@repo/platform-protocol";

/**
 * Replaces preflight estimates with the provider's measured prompt size after
 * each model call while retaining the model-owned context-window policy.
 */
export function reconcileProviderContextBudget(
  budget: ContextBudgetSnapshot | undefined,
  usage: UsageCostSnapshot,
): ContextBudgetSnapshot | undefined {
  if (!budget) return undefined;
  const tokensUsed = usage.inputTokens;
  return ContextBudgetSnapshotSchema.parse({
    ...budget,
    tokensUsed,
    tokensRemaining: Math.max(0, budget.effectiveInputBudget - tokensUsed),
    utilizationPercent: Math.min(
      100,
      (tokensUsed / budget.effectiveInputBudget) * 100,
    ),
    measurementSource: "provider",
  });
}
