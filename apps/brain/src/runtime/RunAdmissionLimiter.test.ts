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

    expect(await release(limiter, "attempt-1")).toEqual({ released: true });
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
): Promise<Record<string, unknown>> {
  const response = await limiter.fetch(
    request("/release-concurrency", { leaseId }),
  );
  return (await response.json()) as Record<string, unknown>;
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
