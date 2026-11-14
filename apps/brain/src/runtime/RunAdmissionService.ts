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

  /** The retained original attempt calls this only after positive cleanup.
   * Failure propagates so queued work cannot advance on an unconfirmed release. */
  async releaseAttempt(runAttemptId: string, correlationId: string): Promise<void> {
    await this.limiterClient.release(runAdmissionLeaseForAttempt(runAttemptId), correlationId);
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
