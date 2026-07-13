import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../types/ai";

const EnforceRequestSchema = z.object({
  bucket: z.enum(["run_submission", "mutation_run_submission"]),
  scopeKey: z.string().min(1).max(512),
  limit: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
});

type EnforceRequest = z.infer<typeof EnforceRequestSchema>;

const ConcurrencyConstraintSchema = z.object({
  bucket: z.enum([
    "concurrent_expensive_run_session",
    "concurrent_expensive_run_user",
    "concurrent_expensive_run_workspace",
  ]),
  scopeKey: z.string().min(1).max(256),
  limit: z.number().int().positive(),
});

const AcquireConcurrencyRequestSchema = z.object({
  leaseId: z.string().min(1).max(256),
  leaseTtlSeconds: z.number().int().positive(),
  constraints: z.array(ConcurrencyConstraintSchema).min(1),
});

const ReleaseConcurrencyRequestSchema = z.object({
  leaseId: z.string().min(1).max(256),
});

type AcquireConcurrencyRequest = z.infer<typeof AcquireConcurrencyRequestSchema>;
type ReleaseConcurrencyRequest = z.infer<typeof ReleaseConcurrencyRequestSchema>;
type ConcurrencyBucket = z.infer<typeof ConcurrencyConstraintSchema>["bucket"];

interface EnforceResponse {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface AcquireConcurrencyResponse {
  allowed: boolean;
  retryAfterSeconds: number;
  leaseId?: string;
  blockedBucket?: ConcurrencyBucket;
}

interface ReleaseConcurrencyResponse {
  released: boolean;
}

interface WindowCounterState {
  windowBucket: number;
  count: number;
}

interface ConcurrencyBucketState {
  leaseIds: string[];
}

interface ConcurrencyLeaseState {
  expiresAt: number;
  bucketKeys: string[];
}

interface PrunedLeaseIds {
  leaseIds: string[];
  changed: boolean;
  nextExpiryMs?: number;
}

const COUNTER_KEY_PREFIX = "launch:admission:v1:";
const CONCURRENCY_BUCKET_KEY_PREFIX = "launch:concurrency:bucket:v1:";
const CONCURRENCY_LEASE_KEY_PREFIX = "launch:concurrency:lease:v1:";

export class RunAdmissionLimiter extends DurableObject {
  private admissionQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    return this.withAdmissionLock(async () => {
      try {
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        if (url.pathname === "/enforce") {
          const payload = EnforceRequestSchema.parse(await request.json());
          const result = await this.enforceLimit(payload);
          return jsonResponse(result, 200);
        }

        if (url.pathname === "/acquire-concurrency") {
          const payload = AcquireConcurrencyRequestSchema.parse(
            await request.json(),
          );
          const result = await this.acquireConcurrencyLease(payload);
          return jsonResponse(result, 200);
        }

        if (url.pathname === "/release-concurrency") {
          const payload = ReleaseConcurrencyRequestSchema.parse(
            await request.json(),
          );
          const result = await this.releaseConcurrencyLease(payload);
          return jsonResponse(result, 200);
        }

        return new Response("Not Found", { status: 404 });
      } catch (error: unknown) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
          return jsonResponse({ error: "Invalid run admission payload" }, 400);
        }

        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[run/admission-limiter] Failed to enforce limit:", message);
        return jsonResponse({ error: "Failed to enforce run admission limit" }, 500);
      }
    });
  }

  private async enforceLimit(payload: EnforceRequest): Promise<EnforceResponse> {
    const now = Date.now();
    const windowMs = payload.windowSeconds * 1000;
    const activeWindow = Math.floor(now / windowMs);
    const key = this.buildCounterKey(payload.bucket, payload.scopeKey);
    const current = await this.readCounter(key);

    if (!current || current.windowBucket !== activeWindow) {
      await this.writeCounter(key, {
        windowBucket: activeWindow,
        count: 1,
      });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= payload.limit) {
      return {
        allowed: false,
        retryAfterSeconds: this.computeRetryAfterSeconds(
          activeWindow,
          windowMs,
          now,
        ),
      };
    }

    await this.writeCounter(key, {
      windowBucket: current.windowBucket,
      count: current.count + 1,
    });

    return { allowed: true, retryAfterSeconds: 0 };
  }

  private async acquireConcurrencyLease(
    payload: AcquireConcurrencyRequest,
  ): Promise<AcquireConcurrencyResponse> {
    const now = Date.now();
    const idempotentResult = await this.checkExistingLease(payload, now);
    if (idempotentResult) {
      return idempotentResult;
    }

    const bucketKeys = this.resolveConcurrencyBucketKeys(payload);
    const blockedResult = await this.checkConcurrencyConstraints(
      payload,
      bucketKeys,
      now,
    );
    if (blockedResult) {
      return blockedResult;
    }

    await this.persistConcurrencyLease(payload, bucketKeys, now);
    return this.createAllowedConcurrencyResponse(payload.leaseId);
  }

  private async checkExistingLease(
    payload: AcquireConcurrencyRequest,
    now: number,
  ): Promise<AcquireConcurrencyResponse | null> {
    const existingLease = await this.readLease(payload.leaseId);
    if (!existingLease) {
      return null;
    }

    if (existingLease.expiresAt > now) {
      return this.createAllowedConcurrencyResponse(payload.leaseId);
    }

    await this.releaseLease(payload.leaseId);
    return null;
  }

  private resolveConcurrencyBucketKeys(
    payload: AcquireConcurrencyRequest,
  ): string[] {
    return payload.constraints.map((constraint) =>
      this.buildConcurrencyBucketKey(constraint.bucket, constraint.scopeKey),
    );
  }

  private async checkConcurrencyConstraints(
    payload: AcquireConcurrencyRequest,
    bucketKeys: string[],
    now: number,
  ): Promise<AcquireConcurrencyResponse | null> {
    for (let index = 0; index < payload.constraints.length; index += 1) {
      const constraint = payload.constraints[index]!;
      const bucketKey = bucketKeys[index]!;
      const state = await this.readConcurrencyBucketState(bucketKey);
      const pruned = await this.pruneLeaseIds(state.leaseIds, now);
      if (pruned.changed) {
        await this.writeConcurrencyBucketState(bucketKey, {
          leaseIds: pruned.leaseIds,
        });
      }
      if (pruned.leaseIds.length >= constraint.limit) {
        return {
          allowed: false,
          retryAfterSeconds: computeRetryAfterSecondsFromExpiry(
            pruned.nextExpiryMs,
            now,
          ),
          blockedBucket: constraint.bucket,
        };
      }
    }
    return null;
  }

  private async persistConcurrencyLease(
    payload: AcquireConcurrencyRequest,
    bucketKeys: string[],
    now: number,
  ): Promise<void> {
    const leaseTtlMs = payload.leaseTtlSeconds * 1000;
    await this.writeLease(payload.leaseId, {
      expiresAt: now + leaseTtlMs,
      bucketKeys,
    });

    for (const bucketKey of bucketKeys) {
      const state = await this.readConcurrencyBucketState(bucketKey);
      if (state.leaseIds.includes(payload.leaseId)) {
        continue;
      }
      await this.writeConcurrencyBucketState(bucketKey, {
        leaseIds: [...state.leaseIds, payload.leaseId],
      });
    }
  }

  private createAllowedConcurrencyResponse(
    leaseId: string,
  ): AcquireConcurrencyResponse {
    return {
      allowed: true,
      retryAfterSeconds: 0,
      leaseId,
    };
  }

  private async releaseConcurrencyLease(
    payload: ReleaseConcurrencyRequest,
  ): Promise<ReleaseConcurrencyResponse> {
    const released = await this.releaseLease(payload.leaseId);
    return { released };
  }

  private async readCounter(key: string): Promise<WindowCounterState | null> {
    const raw = await this.ctx.storage.get<string>(key);
    if (typeof raw !== "string") {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as WindowCounterState;
      if (
        !Number.isInteger(parsed.windowBucket) ||
        !Number.isInteger(parsed.count) ||
        parsed.windowBucket < 0 ||
        parsed.count < 0
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeCounter(
    key: string,
    state: WindowCounterState,
  ): Promise<void> {
    await this.ctx.storage.put(key, JSON.stringify(state));
  }

  private async readConcurrencyBucketState(
    key: string,
  ): Promise<ConcurrencyBucketState> {
    const raw = await this.ctx.storage.get<string>(key);
    if (typeof raw !== "string") {
      return { leaseIds: [] };
    }

    try {
      const parsed = JSON.parse(raw) as ConcurrencyBucketState;
      if (!Array.isArray(parsed.leaseIds)) {
        return { leaseIds: [] };
      }
      const normalizedLeaseIds = parsed.leaseIds.filter(
        (leaseId): leaseId is string => typeof leaseId === "string" && leaseId.length > 0,
      );
      return { leaseIds: normalizedLeaseIds };
    } catch {
      return { leaseIds: [] };
    }
  }

  private async writeConcurrencyBucketState(
    key: string,
    state: ConcurrencyBucketState,
  ): Promise<void> {
    if (state.leaseIds.length === 0) {
      await this.ctx.storage.delete(key);
      return;
    }
    await this.ctx.storage.put(key, JSON.stringify(state));
  }

  private async readLease(leaseId: string): Promise<ConcurrencyLeaseState | null> {
    const raw = await this.ctx.storage.get<string>(this.buildLeaseKey(leaseId));
    if (typeof raw !== "string") {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as ConcurrencyLeaseState;
      if (
        typeof parsed.expiresAt !== "number" ||
        !Number.isFinite(parsed.expiresAt) ||
        !Array.isArray(parsed.bucketKeys)
      ) {
        return null;
      }
      const bucketKeys = parsed.bucketKeys.filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      );
      return {
        expiresAt: parsed.expiresAt,
        bucketKeys,
      };
    } catch {
      return null;
    }
  }

  private async writeLease(
    leaseId: string,
    state: ConcurrencyLeaseState,
  ): Promise<void> {
    await this.ctx.storage.put(this.buildLeaseKey(leaseId), JSON.stringify(state));
  }

  private async releaseLease(leaseId: string): Promise<boolean> {
    const lease = await this.readLease(leaseId);
    await this.ctx.storage.delete(this.buildLeaseKey(leaseId));
    if (!lease) {
      return false;
    }

    for (const bucketKey of lease.bucketKeys) {
      const state = await this.readConcurrencyBucketState(bucketKey);
      if (state.leaseIds.length === 0) {
        continue;
      }
      const nextLeaseIds = state.leaseIds.filter(
        (candidate) => candidate !== leaseId,
      );
      if (nextLeaseIds.length !== state.leaseIds.length) {
        await this.writeConcurrencyBucketState(bucketKey, {
          leaseIds: nextLeaseIds,
        });
      }
    }

    return true;
  }

  private async pruneLeaseIds(
    leaseIds: string[],
    now: number,
  ): Promise<PrunedLeaseIds> {
    const uniqueLeaseIds = Array.from(new Set(leaseIds));
    const activeLeaseIds: string[] = [];
    let changed = uniqueLeaseIds.length !== leaseIds.length;
    let nextExpiryMs: number | undefined;

    for (const leaseId of uniqueLeaseIds) {
      const lease = await this.readLease(leaseId);
      if (!lease) {
        changed = true;
        continue;
      }

      if (lease.expiresAt <= now) {
        changed = true;
        await this.ctx.storage.delete(this.buildLeaseKey(leaseId));
        continue;
      }

      activeLeaseIds.push(leaseId);
      if (nextExpiryMs === undefined || lease.expiresAt < nextExpiryMs) {
        nextExpiryMs = lease.expiresAt;
      }
    }

    return {
      leaseIds: activeLeaseIds,
      changed,
      nextExpiryMs,
    };
  }

  private computeRetryAfterSeconds(
    windowBucket: number,
    windowMs: number,
    now: number,
  ): number {
    const windowEnd = (windowBucket + 1) * windowMs;
    const remainingMs = Math.max(windowEnd - now, 1000);
    return Math.ceil(remainingMs / 1000);
  }

  private buildCounterKey(
    bucket: EnforceRequest["bucket"],
    scopeKey: string,
  ): string {
    return `${COUNTER_KEY_PREFIX}${bucket}:${scopeKey}`;
  }

  private buildConcurrencyBucketKey(
    bucket: ConcurrencyBucket,
    scopeKey: string,
  ): string {
    return `${CONCURRENCY_BUCKET_KEY_PREFIX}${bucket}:${scopeKey}`;
  }

  private buildLeaseKey(leaseId: string): string {
    return `${CONCURRENCY_LEASE_KEY_PREFIX}${leaseId}`;
  }

  private async withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionQueue;
    let release: () => void = () => {};
    this.admissionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function computeRetryAfterSecondsFromExpiry(
  nextExpiryMs: number | undefined,
  now: number,
): number {
  if (nextExpiryMs === undefined) {
    return 1;
  }
  const remainingMs = Math.max(nextExpiryMs - now, 1000);
  return Math.ceil(remainingMs / 1000);
}
