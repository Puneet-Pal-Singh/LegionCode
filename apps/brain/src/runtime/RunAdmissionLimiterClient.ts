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
  generation: z.string().min(1).max(256).optional(),
  created: z.boolean().optional(),
  blockedBucket: z
    .enum([
      "concurrent_expensive_run_session",
      "concurrent_expensive_run_user",
      "concurrent_expensive_run_workspace",
      "cloudflare_sandbox_capacity",
    ])
    .optional(),
});
const ReleaseDecisionSchema = z.object({ released: z.boolean() });
const ClaimDecisionSchema = z.object({ claimed: z.boolean() });

export interface RunAdmissionLease {
  readonly leaseId: string;
  readonly generation?: string;
  readonly created?: boolean;
}

export function runAdmissionLeaseForAttempt(runAttemptId: string): RunAdmissionLease {
  return { leaseId: `run-attempt:${runAttemptId}` };
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
    const { leaseId } = runAdmissionLeaseForAttempt(identity.runAttemptId);
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
      const capacityExhausted =
        decision.blockedBucket === "cloudflare_sandbox_capacity";
      throw new DomainError(
        capacityExhausted
          ? "RUN_CAPACITY_EXHAUSTED"
          : "RUN_ADMISSION_BLOCKED",
        capacityExhausted
          ? `Sandbox capacity is currently full. Retry in ${decision.retryAfterSeconds}s.`
          : `Run admission is blocked by ${decision.blockedBucket ?? "runtime policy"}. Retry in ${decision.retryAfterSeconds}s.`,
        429,
        true,
        correlationId,
        {
          admissionState: "blocked",
          failureKind: capacityExhausted
            ? "capacity_exhausted"
            : "policy_rejected",
          retryAfterSeconds: decision.retryAfterSeconds,
          blockedBucket: decision.blockedBucket ?? null,
          runAttemptId: identity.runAttemptId,
        },
      );
    }
    if (decision.leaseId !== undefined && decision.leaseId !== leaseId) {
      throw new DomainError("RUN_ADMISSION_LEASE_SCOPE_MISMATCH", "The limiter returned a different attempt lease.", 503, false, correlationId);
    }
    return Object.freeze({ leaseId, generation: decision.generation, created: decision.created });
  }

  async transferToRuntime(lease: RunAdmissionLease, claimId: string, correlationId: string): Promise<void> {
    if (!lease.generation) throw new DomainError("RUN_ADMISSION_LEASE_OWNERSHIP_UNKNOWN", "Admission ownership is unknown.", 409, false, correlationId);
    const result = parseResponse(ClaimDecisionSchema, await this.post("/claim-concurrency", {
      leaseId: lease.leaseId, expectedGeneration: lease.generation, claimId,
    }, correlationId), correlationId);
    if (!result.claimed) throw new DomainError("RUN_ADMISSION_LEASE_HANDOFF_FAILED", "Admission ownership could not be transferred to this execution claim.", 409, false, correlationId);
  }

  async release(
    lease: RunAdmissionLease,
    correlationId: string,
    claimId: string | null = null,
  ): Promise<void> {
    if (!lease.generation) {
      throw new DomainError("RUN_ADMISSION_LEASE_OWNERSHIP_UNKNOWN", "The admission lease has no confirmed ownership generation.", 409, false, correlationId);
    }
    const decision = parseResponse(
      ReleaseDecisionSchema,
      await this.post(
        "/release-concurrency",
        { leaseId: lease.leaseId, expectedGeneration: lease.generation, expectedClaimId: claimId },
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
    path: "/enforce" | "/acquire-concurrency" | "/claim-concurrency" | "/release-concurrency",
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
