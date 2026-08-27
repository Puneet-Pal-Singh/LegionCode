import type { ProviderRecoveryReason } from "./NativeProviderRequestRecovery.js";

export function buildProviderRecoveryIdempotencyKey(
  baseKey: string,
  retryCount: number,
): string {
  if (retryCount === 0) return baseKey;
  return `${baseKey}:provider-retry:${retryCount}`;
}

export function buildProviderRecoveryProgress(input: {
  delayMs: number;
  retryCount: number;
  reason: ProviderRecoveryReason;
  turnId: string;
}): {
  title: string;
  detail: string;
  metadata: {
    retryCount: number;
    reason: ProviderRecoveryReason;
    retryAfterSeconds: number;
    turnId: string;
  };
} {
  const seconds = Math.max(1, Math.ceil(input.delayMs / 1_000));
  const rateLimited = input.reason === "rate_limit";
  return {
    title: rateLimited ? "Provider cooldown" : "Provider retry",
    detail: rateLimited
      ? `The model provider asked LegionCode to retry in ${seconds}s. Waiting before the next model request.`
      : `The model provider returned a temporary error. Retrying in ${seconds}s.`,
    metadata: {
      retryCount: input.retryCount,
      reason: input.reason,
      retryAfterSeconds: seconds,
      turnId: input.turnId,
    },
  };
}
