import { describe, expect, it, vi } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "../types/ai";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { RunAdmissionLimiter } from "./RunAdmissionLimiter";

describe("RunAdmissionLimiter", () => {
  it("admits concurrent attempts from different threads within workspace policy", async () => {
    const limiter = createLimiter();

    const [first, second] = await Promise.all([
      acquire(limiter, "attempt-1", "thread-1", "workspace-1", 2),
      acquire(limiter, "attempt-2", "thread-2", "workspace-1", 2),
    ]);

    expect(first).toMatchObject({ allowed: true, leaseId: "attempt-1" });
    expect(second).toMatchObject({ allowed: true, leaseId: "attempt-2" });
    expect(first.created).toBe(true);
    expect(first.generation).toEqual(expect.any(String));
    expect(second.generation).not.toBe(first.generation);
    expect(await acquire(limiter, "attempt-1", "thread-1", "workspace-1", 2)).toMatchObject({ generation: first.generation, created: false });
    expect(await claim(limiter, "attempt-1", first.generation, "claim-1")).toEqual({ claimed: true });
    expect(await release(limiter, "attempt-1", first.generation)).toEqual({ released: false });
    expect(await release(limiter, "attempt-1", first.generation, "other-claim")).toEqual({ released: false });
    expect(await claim(limiter, "attempt-1", first.generation, "claim-1")).toEqual({ claimed: true });
    expect(await release(limiter, "attempt-1", first.generation, "claim-1")).toEqual({ released: true });
    const recreated = await acquire(limiter, "attempt-1", "thread-1", "workspace-1", 2);
    expect(recreated).toMatchObject({ created: true });
    expect(recreated.generation).not.toBe(first.generation);
    expect(await release(limiter, "attempt-1", first.generation, "claim-1")).toEqual({ released: false });
    expect(await release(limiter, "attempt-1", recreated.generation)).toEqual({ released: true });

    const legacyState = new MockDurableObjectState();
    await legacyState.storage.put("launch:concurrency:lease:v1:legacy", JSON.stringify({ expiresAt: Date.now() + 60_000, bucketKeys: [] }));
    const legacy = new RunAdmissionLimiter(legacyState as unknown as DurableObjectState, {} as Env);
    expect(await acquire(legacy, "legacy", "legacy", "legacy", 2)).toMatchObject({ allowed: true, created: false });
    expect(await release(legacy, "legacy", "fabricated")).toEqual({ released: false });
    expect(await claim(legacy, "legacy", "fabricated", "claim-legacy")).toEqual({ claimed: false });
  });

  it("blocks a sibling in a constrained workspace and frees only its released lease", async () => {
    const limiter = createLimiter();
    const first = await acquire(
      limiter,
      "attempt-1",
      "thread-1",
      "workspace-1",
      1,
    );
    const blocked = await acquire(
      limiter,
      "attempt-2",
      "thread-2",
      "workspace-1",
      1,
    );

    expect(first).toMatchObject({ allowed: true, leaseId: "attempt-1" });
    expect(blocked).toMatchObject({
      allowed: false,
      blockedBucket: "concurrent_expensive_run_workspace",
    });

    expect(await release(limiter, "attempt-2")).toEqual({ released: false });
    expect(
      await acquire(limiter, "attempt-3", "thread-3", "workspace-1", 1),
    ).toMatchObject({
      allowed: false,
      blockedBucket: "concurrent_expensive_run_workspace",
    });

    expect(await release(limiter, "attempt-1", first.generation)).toEqual({ released: true });
    expect(
      await acquire(limiter, "attempt-3", "thread-3", "workspace-1", 1),
    ).toMatchObject({
      allowed: true,
      leaseId: "attempt-3",
    });
  });
});

function createLimiter(): RunAdmissionLimiter {
  return new RunAdmissionLimiter(
    new MockDurableObjectState() as unknown as DurableObjectState,
    {} as Env,
  );
}

async function acquire(
  limiter: RunAdmissionLimiter,
  leaseId: string,
  threadId: string,
  workspaceId: string,
  workspaceLimit: number,
): Promise<Record<string, unknown>> {
  const response = await limiter.fetch(
    request("/acquire-concurrency", {
      leaseId,
      leaseTtlSeconds: 60,
      constraints: [
        {
          bucket: "concurrent_expensive_run_session",
          scopeKey: `thread:${threadId}`,
          limit: 1,
        },
        {
          bucket: "concurrent_expensive_run_user",
          scopeKey: "user:user-1",
          limit: 3,
        },
        {
          bucket: "concurrent_expensive_run_workspace",
          scopeKey: `workspace:${workspaceId}`,
          limit: workspaceLimit,
        },
      ],
    }),
  );
  return (await response.json()) as Record<string, unknown>;
}

async function release(
  limiter: RunAdmissionLimiter,
  leaseId: string,
  expectedGeneration?: unknown,
  expectedClaimId: string | null = null,
): Promise<Record<string, unknown>> {
  const response = await limiter.fetch(
    request("/release-concurrency", { leaseId, expectedGeneration, expectedClaimId }),
  );
  return (await response.json()) as Record<string, unknown>;
}

async function claim(limiter: RunAdmissionLimiter, leaseId: string, expectedGeneration: unknown, claimId: string) {
  const response = await limiter.fetch(request("/claim-concurrency", { leaseId, expectedGeneration, claimId }));
  return await response.json();
}

function request(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://run-admission-limiter${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

class MockDurableObjectState {
  readonly storage = new InMemoryStorage();
}

class InMemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}
