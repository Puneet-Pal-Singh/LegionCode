import { describe, expect, it } from "vitest";
import {
  buildProviderRecoveryIdempotencyKey,
  buildProviderRecoveryProgress,
} from "./NativeProviderRecoveryProgress.js";

describe("native provider recovery progress", () => {
  it("uses a stable provider retry key after the first attempt", () => {
    expect(buildProviderRecoveryIdempotencyKey("llm-step", 0)).toBe(
      "llm-step",
    );
    expect(buildProviderRecoveryIdempotencyKey("llm-step", 1)).toBe(
      "llm-step:provider-retry:1",
    );
  });

  it("describes rate-limit and transient recovery without exposing provider errors", () => {
    expect(
      buildProviderRecoveryProgress({
        delayMs: 2_100,
        retryCount: 1,
        reason: "rate_limit",
        turnId: "trn_123456",
      }),
    ).toMatchObject({
      title: "Provider cooldown",
      detail: expect.stringContaining("retry in 3s"),
      metadata: { reason: "rate_limit", retryAfterSeconds: 3 },
    });
    expect(
      buildProviderRecoveryProgress({
        delayMs: 1_000,
        retryCount: 1,
        reason: "transient",
        turnId: "trn_123456",
      }),
    ).toMatchObject({
      title: "Provider retry",
      detail: expect.stringContaining("temporary error"),
      metadata: { reason: "transient", retryAfterSeconds: 1 },
    });
  });
});
