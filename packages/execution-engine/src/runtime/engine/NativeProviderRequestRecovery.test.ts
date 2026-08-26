import { describe, expect, it, vi } from "vitest";
import {
  isProviderRecoveryError,
  resolveProviderRetryDelayMs,
  runWithProviderRequestRecovery,
} from "./NativeProviderRequestRecovery.js";

describe("native provider request recovery", () => {
  it("recovers bounded transient provider failures, not deterministic client errors", () => {
    expect(isProviderRecoveryError({ statusCode: 408 })).toBe(true);
    expect(isProviderRecoveryError({ statusCode: 503 })).toBe(true);
    expect(isProviderRecoveryError({ retryable: true, statusCode: 400 })).toBe(
      true,
    );
    expect(isProviderRecoveryError({ statusCode: 400 })).toBe(false);
  });

  it("honors Retry-After headers before exponential defaults", () => {
    expect(
      resolveProviderRetryDelayMs({
        statusCode: 503,
        headers: { "retry-after": "4" },
      }),
    ).toBe(4_000);
    expect(resolveProviderRetryDelayMs({ statusCode: 503 })).toBe(1_000);
  });

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
    const onRetry = vi.fn();

    await expect(
      runWithProviderRequestRecovery(operation, { sleep, onRetry }),
    ).resolves.toEqual({ value: "done", retryCount: 1 });
    expect(sleep).toHaveBeenCalledWith(49_737, undefined);
    expect(onRetry).toHaveBeenCalledWith(49_737, 1, "rate_limit");
    expect(operation).toHaveBeenNthCalledWith(1, 0);
    expect(operation).toHaveBeenNthCalledWith(2, 1);
  });

  it("retries a transient 500 once and preserves the final typed failure", async () => {
    const transient = Object.assign(new Error("upstream unavailable"), {
      statusCode: 500,
    });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("recovered");
    const onRetry = vi.fn();

    await expect(
      runWithProviderRequestRecovery(operation, {
        sleep: vi.fn().mockResolvedValue(undefined),
        onRetry,
      }),
    ).resolves.toEqual({ value: "recovered", retryCount: 1 });
    expect(onRetry).toHaveBeenCalledWith(1_000, 1, "transient");

    const exhausted = vi.fn().mockRejectedValue(transient);
    await expect(
      runWithProviderRequestRecovery(exhausted, {
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toBe(transient);
    expect(exhausted).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second provider rate-limit failure", async () => {
    const failure = Object.assign(new Error("RESOURCE_EXHAUSTED"), {
      statusCode: 429,
    });
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(
      runWithProviderRequestRecovery(operation, {
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
