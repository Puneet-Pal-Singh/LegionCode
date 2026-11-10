import {
  ReasoningEffortSchema,
  type ReasoningEffort,
} from "@repo/shared-types";

export function normalizeReasoningEfforts(
  efforts: readonly string[] | undefined,
): ReasoningEffort[] {
  if (!efforts) {
    return [];
  }

  return Array.from(
    new Set(
      efforts.filter(
        (effort): effort is ReasoningEffort =>
          ReasoningEffortSchema.safeParse(effort).success,
      ),
    ),
  );
}
