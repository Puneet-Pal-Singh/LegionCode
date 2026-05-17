/**
 * ByokRateLimiter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ByokRateLimiter } from "./ByokRateLimiter";

describe("ByokRateLimiter", () => {
  let limiter: ByokRateLimiter;

  beforeEach(() => {
    // Each test gets a fresh limiter to avoid global state pollution
    limiter = new ByokRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: Some tests create fresh limiters, others use shared limiter
  // but each describe block should start fresh

  describe("checkLimit", () => {
    it("should allow operations within limit", async () => {
      const result = await limiter.checkLimit(
        "connect",
        "user-1",
        "ws-1"
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it("should enforce connect rate limit (10/min)", async () => {
      // Use fresh limiter for isolated test
      const testLimiter = new ByokRateLimiter();

      // Consume burst capacity (15 for connect)
      for (let i = 0; i < 15; i++) {
        const result = await testLimiter.checkLimit("connect", "user-1", "ws-1");
        expect(result.allowed).toBe(true);
      }

      // Next should be rate limited
      const result = await testLimiter.checkLimit("connect", "user-1", "ws-1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("should enforce validate rate limit (30/min)", async () => {
      // Use fresh limiter for isolated test
      const testLimiter = new ByokRateLimiter();

      // Consume burst capacity (45 for validate = 30 * 1.5)
      for (let i = 0; i < 45; i++) {
        const result = await testLimiter.checkLimit("validate", "user-1", "ws-1");
        expect(result.allowed).toBe(true);
      }

      // Next should be rate limited
      const result = await testLimiter.checkLimit("validate", "user-1", "ws-1");
      expect(result.allowed).toBe(false);
    });

    it("should enforce resolve rate limit (300/min)", async () => {
      // Use fresh limiter for isolated test
      const testLimiter = new ByokRateLimiter();

      // Consume burst capacity (450 for resolve = 300 * 1.5)
      // But global limit is 2000, so we'll hit that first
      let allowedCount = 0;
      for (let i = 0; i < 500; i++) {
        const result = await testLimiter.checkLimit("resolve", "user-1", "ws-1");
        if (result.allowed) {
          allowedCount++;
        } else {
          break;
        }
      }

      // Should have allowed at least 450 (resolve burst)
      expect(allowedCount).toBeGreaterThanOrEqual(450);

      // Next should be rate limited
      const result = await testLimiter.checkLimit("resolve", "user-1", "ws-1");
      expect(result.allowed).toBe(false);
    });

    it("should isolate limits per user", async () => {
      // User 1 consumes all connect tokens
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit("connect", "user-1", "ws-1");
      }

      // User 2 should still be able to connect
      const result = await limiter.checkLimit("connect", "user-2", "ws-1");
      expect(result.allowed).toBe(true);
    });

    it("should isolate limits per workspace", async () => {
      // Workspace 1 consumes all tokens
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit("connect", "user-1", "ws-1");
      }

      // Same user, different workspace should succeed
      const result = await limiter.checkLimit("connect", "user-1", "ws-2");
      expect(result.allowed).toBe(true);
    });

    it("should isolate limits per operation", async () => {
      // Consume connect limit
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit("connect", "user-1", "ws-1");
      }

      // Validate should still work
      const result = await limiter.checkLimit("validate", "user-1", "ws-1");
      expect(result.allowed).toBe(true);
    });

    it("should include provider in bucket key when provided", async () => {
      // Consume tokens for openai
      for (let i = 0; i < 10; i++) {
        await limiter.checkLimit("connect", "user-1", "ws-1", "openai");
      }

      // Different provider should succeed
      const result = await limiter.checkLimit(
        "connect",
        "user-1",
        "ws-1",
        "anthropic"
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("getRemainingTokens", () => {
    it("should report remaining tokens", async () => {
      const testLimiter = new ByokRateLimiter();

      const initial = testLimiter.getRemainingTokens(
        "connect",
        "user-1",
        "ws-1"
      );

      expect(initial).toBeGreaterThan(0);

      // Consume all tokens quickly to avoid refill
      let consumed = 0;
      while (consumed < initial) {
        const result = await testLimiter.checkLimit("connect", "user-1", "ws-1");
        if (result.allowed) {
          consumed++;
        } else {
          break;
        }
      }

      const remaining = testLimiter.getRemainingTokens(
        "connect",
        "user-1",
        "ws-1"
      );

      // May have refilled slightly, but should be less than or equal to initial
      expect(remaining).toBeLessThanOrEqual(initial);
    });

    it("should report full capacity for new user", async () => {
      // Use fresh limiter to ensure full global budget
      const freshLimiter = new ByokRateLimiter();

      // First user should have burst capacity (15 for connect with 10/min rate)
      const firstRemaining = freshLimiter.getRemainingTokens(
        "connect",
        "new-user-1",
        "ws-1"
      );
      expect(firstRemaining).toBeGreaterThan(0);

      // Second fresh user on same limiter should also have full burst
      const secondRemaining = freshLimiter.getRemainingTokens(
        "connect",
        "new-user-2",
        "ws-1"
      );
      expect(secondRemaining).toBe(firstRemaining);
    });
  });

  describe("resetUserLimits", () => {
    it("should clear buckets for user/workspace", async () => {
      const freshLimiter = new ByokRateLimiter();

      // Check initial state
      let remaining = freshLimiter.getRemainingTokens("connect", "user-1", "ws-1");
      const initialCapacity = remaining;
      expect(initialCapacity).toBeGreaterThan(0);

      // Consume ALL the tokens (or most of them)
      let consumed = 0;
      while (consumed < initialCapacity) {
        const result = await freshLimiter.checkLimit("connect", "user-1", "ws-1");
        if (result.allowed) {
          consumed++;
        } else {
          break;
        }
      }

      remaining = freshLimiter.getRemainingTokens("connect", "user-1", "ws-1");
      expect(remaining).toBeLessThan(initialCapacity);

      // Reset
      freshLimiter.resetUserLimits("user-1", "ws-1");

      // Bucket should be recreated (may have refilled slightly due to time passage)
      remaining = freshLimiter.getRemainingTokens("connect", "user-1", "ws-1");
      expect(remaining).toBeGreaterThanOrEqual(initialCapacity / 2);
    });

    it("should only reset target user/workspace", async () => {
      const freshLimiter = new ByokRateLimiter();

      // Get initial capacity
      const user1Before = freshLimiter.getRemainingTokens(
        "connect",
        "user-1",
        "ws-1"
      );
      const user2Before = freshLimiter.getRemainingTokens(
        "connect",
        "user-2",
        "ws-1"
      );

      // Both should have same initial capacity
      expect(user1Before).toBe(user2Before);

      // Reset user 1
      freshLimiter.resetUserLimits("user-1", "ws-1");

      // User 1 should get fresh bucket with same capacity
      const user1After = freshLimiter.getRemainingTokens(
        "connect",
        "user-1",
        "ws-1"
      );
      expect(user1After).toBe(user1Before);

      // User 2's bucket should exist unchanged
      const user2After = freshLimiter.getRemainingTokens(
        "connect",
        "user-2",
        "ws-1"
      );
      expect(user2After).toBe(user2Before);
    });
  });

  describe("getStatistics", () => {
    it("should return active bucket count", async () => {
      await limiter.checkLimit("connect", "user-1", "ws-1");
      await limiter.checkLimit("connect", "user-2", "ws-1");

      const stats = limiter.getStatistics();
      expect(stats.activeBuckets).toBeGreaterThanOrEqual(2);
    });

    it("should report global tokens remaining", async () => {
      const stats = limiter.getStatistics();
      expect(stats.globalTokensRemaining).toBeGreaterThan(0);
    });

    it("should include all limit configs", async () => {
      const stats = limiter.getStatistics();
      expect(stats.limitConfigs.connect).toBeDefined();
      expect(stats.limitConfigs.validate).toBeDefined();
      expect(stats.limitConfigs.resolve).toBeDefined();
    });
  });

  describe("setLimit", () => {
    it("should allow custom limit configuration", async () => {
      const customLimiter = new ByokRateLimiter();
      // Save original limits
      const originalLimits = customLimiter.getStatistics().limitConfigs;

      customLimiter.setLimit("connect", 5); // Reduce to 5/min

      // Consume 5 tokens (burst is 5 * 1.5 = 7.5, rounded to 7)
      for (let i = 0; i < 7; i++) {
        const result = await customLimiter.checkLimit("connect", "user-1", "ws-1");
        expect(result.allowed).toBe(true);
      }

      // 8th should fail
      const result = await customLimiter.checkLimit("connect", "user-1", "ws-1");
      expect(result.allowed).toBe(false);

      // Restore original limits for other tests (not strictly needed since each test gets fresh limiter)
      if (originalLimits.connect) {
        customLimiter.setLimit("connect", originalLimits.connect.tokensPerMinute);
      }
    });
  });

  describe("burst handling", () => {
    it("should allow burst above sustained rate", async () => {
      // Connect has 10/min sustained, 15 burst
      // Should allow 15 consecutive ops
      for (let i = 0; i < 15; i++) {
        const result = await limiter.checkLimit("connect", "user-1", "ws-1");
        expect(result.allowed).toBe(true);
      }

      // 16th should fail
      const result = await limiter.checkLimit("connect", "user-1", "ws-1");
      expect(result.allowed).toBe(false);
    });
  });

  describe("global rate limiting", () => {
    it("should enforce global limit across all operations", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

      const freshLimiter = new ByokRateLimiter();

      // Consume 2000 global tokens (2000/min global)
      // Use resolve which has higher per-user limit (300/min)
      // So we need multiple users to consume global quota
      let consumed = 0;

      for (let userId = 1; userId <= 10 && consumed < 2000; userId++) {
        for (let i = 0; i < 300; i++) {
          const result = await freshLimiter.checkLimit(
            "resolve",
            `user-${userId}`,
            "ws-1"
          );
          if (result.allowed) {
            consumed++;
          } else {
            break;
          }
        }
      }

      // Verify we hit global limit
      expect(consumed).toBeLessThanOrEqual(2000);
      expect(consumed).toBeGreaterThan(1000); // Should get pretty close
    });
  });

  describe("scale hardening", () => {
    it("caps active buckets under high-cardinality traffic", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

      const testLimiter = new ByokRateLimiter();
      const batches = 6;
      const requestsPerBatch = 2000;
      let allowed = 0;

      for (let batch = 0; batch < batches; batch++) {
        for (let i = 0; i < requestsPerBatch; i++) {
          const result = await testLimiter.checkLimit(
            "connect",
            `user-${batch}-${i}`,
            "workspace-scale",
          );
          if (result.allowed) {
            allowed++;
          }
        }

        vi.setSystemTime(Date.now() + 60_000);
      }

      const stats = testLimiter.getStatistics();
      expect(allowed).toBe(batches * requestsPerBatch);
      expect(stats.activeBuckets).toBeLessThanOrEqual(10_000);
    });

    it("keeps global token balance bounded after long idle periods", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

      const testLimiter = new ByokRateLimiter();
      await testLimiter.checkLimit("resolve", "user-1", "workspace-1");

      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);

      const stats = testLimiter.getStatistics();
      expect(stats.globalTokensRemaining).toBeLessThanOrEqual(2000);
      expect(stats.globalTokensRemaining).toBeGreaterThan(0);
    });
  });
});
