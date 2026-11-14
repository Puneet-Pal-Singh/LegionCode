import { z } from "zod";
import { DomainError } from "../domain/errors";
import type { Env } from "../types/ai";
import {
  assertCanonicalRunAdmissionIdentity,
  buildAdmissionPolicy,
  type RunAdmissionInput,
} from "./RunAdmissionPolicy";
import {
  RunAdmissionLimiterClient,
  runAdmissionLeaseForAttempt,
  type RunAdmissionLease,
} from "./RunAdmissionLimiterClient";
import { isRunAdmissionBlocked } from "./RunEmergencyShutoffPolicy";

export type { RunAdmissionInput } from "./RunAdmissionPolicy";

export interface RunAdmissionGrant {
  lease: RunAdmissionLease;
}
const AdmissionScopeSchema = z.object({ userId: z.string(), workspaceId: z.string(), sessionId: z.string(),
  runId: z.string(), threadId: z.string(), turnId: z.string(), runAttemptId: z.string() }).strict();
export type RunAdmissionExecutionScope = z.infer<typeof AdmissionScopeSchema>;
const RejectedExecutionSchema = z.object({ state: z.literal("settled"), scope: AdmissionScopeSchema }).strict();

/** Private DO rejection evidence; it contains no lease generation or credential material. */
export function settledAdmissionRejection(scope: RunAdmissionExecutionScope) {
  return RejectedExecutionSchema.parse({ state: "settled", scope });
}

export class RunAdmissionService {
  private readonly limiterClient: RunAdmissionLimiterClient;

  constructor(private readonly env: Env) {
    this.limiterClient = new RunAdmissionLimiterClient(env);
  }

  async enforce(
    input: Partial<RunAdmissionInput>,
    correlationId: string,
  ): Promise<RunAdmissionGrant> {
    this.enforceEmergencyShutoff(correlationId);
    const identity = assertCanonicalRunAdmissionIdentity(input, correlationId);
    const admissionInput = { ...input, ...identity };
    const policy = buildAdmissionPolicy(admissionInput, this.env);

    await this.limiterClient.enforce(identity, policy, correlationId);
    const lease = await this.limiterClient.acquire(
      identity,
      policy,
      correlationId,
    );
    return { lease };
  }

  async release(
    grant: RunAdmissionGrant | undefined,
    correlationId: string,
  ): Promise<void> {
    if (!grant) return;
    try {
      await this.limiterClient.release(grant.lease, correlationId);
    } catch (error) {
      console.warn(
        `[run/admission] ${correlationId}: failed to settle run admission lease`,
        error,
      );
    }
  }

  /** Transfer only after the canonical PG claim and before acknowledging or executing it. */
  async claimAttempt(runAttemptId: string, lease: RunAdmissionLease | undefined, claimId: string, correlationId: string): Promise<void> {
    const owned = this.requireAttemptLease(runAttemptId, lease, correlationId);
    await this.limiterClient.transferToRuntime(owned, claimId, correlationId);
  }

  /** Called after positive original cleanup; failures keep queue reconciliation gated. */
  async releaseAttempt(runAttemptId: string, lease: RunAdmissionLease | undefined, claimId: string, correlationId: string): Promise<void> {
    await this.limiterClient.release(this.requireAttemptLease(runAttemptId, lease, correlationId), correlationId, claimId);
  }

  /** Disposes only a fresh unused submission generation. The limiter also
   * rejects this release if a runtime has taken ownership; terminal state
   * itself never proves that runtime's physical cleanup. */
  async releaseFreshRejectedAttempt(grant: RunAdmissionGrant | undefined, response: Response,
    expected: RunAdmissionExecutionScope, correlationId: string): Promise<boolean> {
    if (!grant?.lease.created || !grant.lease.generation || response.status !== 409) return false;
    const body = await response.clone().json().catch(() => null) as { code?: unknown; metadata?: { executionRejection?: unknown } } | null;
    if (body?.code !== "TURN_EXECUTION_NOT_CLAIMABLE") return false;
    const rejected = RejectedExecutionSchema.safeParse(body.metadata?.executionRejection);
    if (!rejected.success || Object.keys(expected).some(key => rejected.data.scope[key as keyof RunAdmissionExecutionScope] !== expected[key as keyof RunAdmissionExecutionScope])) return false;
    await this.limiterClient.release(this.requireAttemptLease(expected.runAttemptId, grant.lease, correlationId), correlationId);
    return true;
  }

  private requireAttemptLease(runAttemptId: string, lease: RunAdmissionLease | undefined, correlationId: string): RunAdmissionLease {
    if (!lease?.generation || lease.leaseId !== runAdmissionLeaseForAttempt(runAttemptId).leaseId) {
      throw new DomainError("RUN_ADMISSION_LEASE_OWNERSHIP_UNKNOWN", "The execution has no matching admission ownership receipt.", 409, false, correlationId);
    }
    return lease;
  }

  private enforceEmergencyShutoff(correlationId: string): void {
    if (!isRunAdmissionBlocked(this.env)) {
      return;
    }
    throw new DomainError(
      "EMERGENCY_SHUTOFF_ACTIVE",
      "LegionCode is temporarily in maintenance mode while launch traffic is being stabilized. Please try again shortly.",
      503,
      true,
      correlationId,
      { mode: "block_runs" },
    );
  }
}
