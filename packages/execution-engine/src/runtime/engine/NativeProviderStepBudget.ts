const TOOL_CALL_SAFETY_MULTIPLIER = 16;
const MINIMUM_TOOL_CALL_SAFETY_LIMIT = 100;

/** The agentic budget counts model steps; parallel calls share one step. */
export function getNativeToolCallSafetyLimit(maxSteps: number): number {
  return Math.max(
    MINIMUM_TOOL_CALL_SAFETY_LIMIT,
    maxSteps * TOOL_CALL_SAFETY_MULTIPLIER,
  );
}

export function shouldForceNativeFinalSynthesis(
  stepsExecuted: number,
  maxSteps: number,
): boolean {
  return stepsExecuted >= Math.max(0, maxSteps - 1);
}
