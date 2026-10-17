export function readPreExecutionRejection(value: unknown): {
  kind: "pre_execution_rejection";
  ruleId: string;
  reason: string;
  correctionGuidance: string;
  executionStarted: false;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "pre_execution_rejection" ||
    record.executionStarted !== false ||
    typeof record.ruleId !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.correctionGuidance !== "string"
  ) {
    return null;
  }
  return {
    kind: "pre_execution_rejection",
    ruleId: record.ruleId,
    reason: record.reason,
    correctionGuidance: record.correctionGuidance,
    executionStarted: false,
  };
}
