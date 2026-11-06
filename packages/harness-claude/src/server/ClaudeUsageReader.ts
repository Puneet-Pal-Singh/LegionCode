import type {
  SDKRateLimitEvent,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** These are SDK accounting snapshots, not a remaining allowance or billing statement. */
export function readClaudeRunUsage(message: SDKResultMessage) {
  return {
    mainLoopTurnUsage: { ...message.usage },
    // Replace the preceding snapshot; summing these values double-counts streaming turns.
    cumulativeModelUsage: Object.fromEntries(
      Object.entries(message.modelUsage).map(([model, usage]) => [
        model,
        { ...usage },
      ]),
    ),
    cumulativeEstimatedCostUsd: message.total_cost_usd,
  };
}

/** Passive supported notification only; absence stays unknown. Never poll private quota APIs. */
export function readClaudeRateLimit(
  message: SDKRateLimitEvent,
  observedAt: string,
) {
  return { observedAt, value: { ...message.rate_limit_info } };
}
