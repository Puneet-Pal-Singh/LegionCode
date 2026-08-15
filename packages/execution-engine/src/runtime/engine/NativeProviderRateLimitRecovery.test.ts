import { describe, expect, it, vi } from "vitest";
import {
  resolveProviderRetryDelayMs,
  runWithProviderRateLimitRecovery,
} from "./NativeProviderRateLimitRecovery.js";

describe("native provider rate-limit recovery", () => {
  it("waits for the provider retry window and retries exactly once", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(
          new Error("Quota exceeded. Please retry in 49.736432166s."),
          { statusCode: 429 },
        ),
      )
      .mockResolvedValue("done");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRateLimit = vi.fn();

    await expect(
      runWithProviderRateLimitRecovery(operation, { sleep, onRateLimit }),
    ).resolves.toEqual({ value: "done", retryCount: 1 });
    expect(sleep).toHaveBeenCalledWith(49_737, undefined);
    expect(onRateLimit).toHaveBeenCalledWith(49_737, 1);
    expect(operation).toHaveBeenNthCalledWith(1, 0);
    expect(operation).toHaveBeenNthCalledWith(2, 1);
  });

  it("does not retry a second provider rate-limit failure", async () => {
    const failure = Object.assign(new Error("RESOURCE_EXHAUSTED"), {
      statusCode: 429,
    });
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(
      runWithProviderRateLimitRecovery(operation, {
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("reads nested retry details and bounds excessive cooldowns", () => {
    const nested = new Error("Provider request failed", {
      cause: Object.assign(new Error("Please retry after 120 seconds"), {
        statusCode: 429,
      }),
    });

    expect(resolveProviderRetryDelayMs(nested)).toBe(60_000);
  });
});
