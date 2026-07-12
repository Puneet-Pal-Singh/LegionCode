import { z } from "zod";
import { DomainError } from "../domain/errors";
import type { Env } from "../types/ai";
import type {
  AdmissionPolicy,
  RunAdmissionIdentity,
} from "./RunAdmissionPolicy";

const LIMITER_SCOPE = "launch:admission:concurrency:v2";
const AdmissionDecisionSchema = z.object({
  allowed: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative(),
});
const AcquireDecisionSchema = AdmissionDecisionSchema.extend({
  leaseId: z.string().min(1).optional(),
  blockedBucket: z
    .enum([
      "concurrent_expensive_run_session",
      "concurrent_expensive_run_user",
      "concurrent_expensive_run_workspace",
    ])
    .optional(),
});
const ReleaseDecisionSchema = z.object({ released: z.boolean() });

export interface RunAdmissionLease {
  leaseId: string;
}

export class RunAdmissionLimiterClient {
  constructor(private readonly env: Env) {}

  async enforce(
    identity: RunAdmissionIdentity,
    policy: AdmissionPolicy,
    correlationId: string,
  ): Promise<void> {
    const decision = await this.post(
      "/enforce",
      {
        scopeKey: buildRateLimitScope(identity),
        bucket: policy.rateLimit.bucket,
        limit: policy.rateLimit.limit,
        windowSeconds: policy.rateLimit.windowSeconds,
      },
      correlationId,
    );
    const parsed = parseResponse(AdmissionDecisionSchema, decision, correlationId);
    if (!parsed.allowed) {
      throw new DomainError(
        "RUN_SUBMISSION_RATE_LIMITED",
        `Run submission rate limit reached. Retry in ${parsed.retryAfterSeconds}s.`,
        429,
        true,
        correlationId,
        { retryAfterSeconds: parsed.retryAfterSeconds },
      );
    }
  }

  async acquire(
    identity: RunAdmissionIdentity,
    policy: AdmissionPolicy,
    correlationId: string,
  ): Promise<RunAdmissionLease> {
    const leaseId = `run-attempt:${identity.runAttemptId}`;
    const decision = parseResponse(
      AcquireDecisionSchema,
      await this.post(
        "/acquire-concurrency",
        {
          leaseId,
          leaseTtlSeconds: policy.leaseTtlSeconds,
          constraints: policy.concurrencyConstraints,
        },
        correlationId,
      ),
      correlationId,
    );
    if (!decision.allowed) {
      throw new DomainError(
        "RUN_ADMISSION_BLOCKED",
        `Run admission is blocked by ${decision.blockedBucket ?? "runtime capacity"}. Retry in ${decision.retryAfterSeconds}s.`,
        429,
        true,
        correlationId,
        {
          admissionState: "blocked",
          retryAfterSeconds: decision.retryAfterSeconds,
          blockedBucket: decision.blockedBucket ?? null,
          runAttemptId: identity.runAttemptId,
        },
      );
    }
    return { leaseId: decision.leaseId ?? leaseId };
  }

  async release(
    lease: RunAdmissionLease,
    correlationId: string,
  ): Promise<void> {
    const decision = parseResponse(
      ReleaseDecisionSchema,
      await this.post(
        "/release-concurrency",
        { leaseId: lease.leaseId },
        correlationId,
      ),
      correlationId,
    );
    if (!decision.released) {
      throw new DomainError(
        "RUN_ADMISSION_LEASE_NOT_FOUND",
        "Run admission lease was already settled.",
        409,
        false,
        correlationId,
        { leaseId: lease.leaseId },
      );
    }
  }

  private async post(
    path: "/enforce" | "/acquire-concurrency" | "/release-concurrency",
    body: Record<string, unknown>,
    correlationId: string,
  ): Promise<unknown> {
    if (!this.env.RUN_ADMISSION_LIMITER) {
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_UNAVAILABLE",
        "Run admission limiter is unavailable. Please retry shortly.",
        503,
        true,
        correlationId,
      );
    }
    const id = this.env.RUN_ADMISSION_LIMITER.idFromName(LIMITER_SCOPE);
    const response = await this.env.RUN_ADMISSION_LIMITER.get(id).fetch(
      `https://run-admission-limiter${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_UNAVAILABLE",
        `Run admission limiter request failed (${response.status}).`,
        503,
        true,
        correlationId,
        { limiterStatus: response.status },
      );
    }
    return response.json();
  }
}

function buildRateLimitScope(identity: RunAdmissionIdentity): string {
  return `user:${identity.userId}:workspace:${identity.workspaceId}`;
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  correlationId: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      "RUN_ADMISSION_LIMITER_INVALID_RESPONSE",
      "Run admission limiter returned an invalid response.",
      503,
      true,
      correlationId,
    );
  }
  return result.data;
}
