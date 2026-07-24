import type { RunMode, WorkflowIntent } from "@repo/shared-types";
import { DomainError } from "../domain/errors";
import type { Env } from "../types/ai";

const DEFAULT_RUN_SUBMISSION_LIMIT = 60;
const DEFAULT_RUN_SUBMISSION_WINDOW_SECONDS = 600;
const DEFAULT_MUTATION_RUN_SUBMISSION_LIMIT = 20;
const DEFAULT_MUTATION_RUN_SUBMISSION_WINDOW_SECONDS = 600;
const DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX = 1;
const DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX = 2;
const DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX = 3;
const DEFAULT_ACTIVE_EXPENSIVE_RUNS_ANONYMOUS_MAX = 1;
const DEFAULT_ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS = 900;
const CONCURRENCY_LIMITER_SCOPE = "launch:concurrency:shard:v1";

interface RunAdmissionInput {
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
  clientFingerprint?: string;
  mode?: RunMode;
  workflowIntent?: WorkflowIntent;
}

interface ResolvedLimit {
  bucket: "run_submission" | "mutation_run_submission";
  limit: number;
  windowSeconds: number;
}

interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

type ConcurrencyBucket =
  | "concurrent_expensive_run_session"
  | "concurrent_expensive_run_user"
  | "concurrent_expensive_run_workspace";

interface ConcurrencyConstraint {
  bucket: ConcurrencyBucket;
  scopeKey: string;
  limit: number;
}

interface ConcurrencyAcquireDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  leaseId?: string;
  blockedBucket?: ConcurrencyBucket;
}

interface ConcurrencyReleaseDecision {
  released: boolean;
}

export interface RunAdmissionGrant {
  leaseId?: string;
}

/**
 * RunAdmissionService
 * Single Responsibility: enforce launch-safety run admission guardrails.
 */
export class RunAdmissionService {
  constructor(private readonly env: Env) {}

  async enforce(
    input: RunAdmissionInput,
    correlationId: string,
  ): Promise<RunAdmissionGrant> {
    this.enforceEmergencyShutoff(correlationId);
    await this.enforceRateLimit(input, correlationId);
    const leaseId = await this.enforceConcurrency(input, correlationId);
    return leaseId ? { leaseId } : {};
  }

  async release(
    grant: RunAdmissionGrant | undefined,
    input: RunAdmissionInput,
    correlationId: string,
  ): Promise<void> {
    if (!grant?.leaseId) {
      return;
    }

    try {
      await this.releaseConcurrencyLease(grant.leaseId, correlationId);
    } catch (error) {
      console.warn(
        `[run/admission] ${correlationId}: failed to release concurrency lease`,
        error,
      );
    }
  }

  private enforceEmergencyShutoff(correlationId: string): void {
    const mode = this.env.LAUNCH_EMERGENCY_SHUTOFF_MODE?.trim().toLowerCase();
    if (mode !== "block_runs") {
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

  private async enforceRateLimit(
    input: RunAdmissionInput,
    correlationId: string,
  ): Promise<void> {
    const limit = this.resolveLimit(input);
    const decision = await this.requestAdmission(limit, input, correlationId);

    if (!decision.allowed) {
      throw new DomainError(
        "RUN_SUBMISSION_RATE_LIMITED",
        `Run submission rate limit reached. Retry in ${decision.retryAfterSeconds}s.`,
        429,
        true,
        correlationId,
        {
          bucket: limit.bucket,
          limit: limit.limit,
          retryAfterSeconds: decision.retryAfterSeconds,
        },
      );
    }
  }

  private async enforceConcurrency(
    input: RunAdmissionInput,
    correlationId: string,
  ): Promise<string | undefined> {
    if (!this.isMutationCapable(input)) {
      return undefined;
    }

    const constraints = this.buildConcurrencyConstraints(input);
    const leaseId = this.createLeaseId();
    const decision = await this.acquireConcurrencyLease(
      leaseId,
      constraints,
      correlationId,
    );

    if (!decision.allowed) {
      throw new DomainError(
        "RUN_CONCURRENCY_LIMIT_REACHED",
        `Too many active expensive runs. Retry in ${decision.retryAfterSeconds}s.`,
        429,
        true,
        correlationId,
        {
          retryAfterSeconds: decision.retryAfterSeconds,
          blockedBucket: decision.blockedBucket,
        },
      );
    }

    return decision.leaseId ?? leaseId;
  }

  private resolveLimit(input: RunAdmissionInput): ResolvedLimit {
    const mutationCapable = this.isMutationCapable(input);
    if (mutationCapable) {
      return {
        bucket: "mutation_run_submission",
        limit: readPositiveInt(
          this.env.MUTATION_RUN_SUBMISSION_RATE_LIMIT_MAX,
          DEFAULT_MUTATION_RUN_SUBMISSION_LIMIT,
        ),
        windowSeconds: readPositiveInt(
          this.env.MUTATION_RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
          DEFAULT_MUTATION_RUN_SUBMISSION_WINDOW_SECONDS,
        ),
      };
    }

    return {
      bucket: "run_submission",
      limit: readPositiveInt(
        this.env.RUN_SUBMISSION_RATE_LIMIT_MAX,
        DEFAULT_RUN_SUBMISSION_LIMIT,
      ),
      windowSeconds: readPositiveInt(
        this.env.RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
        DEFAULT_RUN_SUBMISSION_WINDOW_SECONDS,
      ),
    };
  }

  private isMutationCapable(input: RunAdmissionInput): boolean {
    if (input.mode === "plan") {
      return false;
    }
    if (input.workflowIntent === "explore" || input.workflowIntent === "review") {
      return false;
    }
    return true;
  }

  private async requestAdmission(
    limit: ResolvedLimit,
    input: RunAdmissionInput,
    correlationId: string,
  ): Promise<RateLimitDecision> {
    if (!this.env.RUN_ADMISSION_LIMITER) {
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_UNAVAILABLE",
        "Run admission limiter is unavailable. Please retry shortly.",
        503,
        true,
        correlationId,
      );
    }

    const scope = this.buildScope(input);
    const id = this.env.RUN_ADMISSION_LIMITER.idFromName(scope);
    const stub = this.env.RUN_ADMISSION_LIMITER.get(id);
    const response = await stub.fetch("https://run-admission-limiter/enforce", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucket: limit.bucket,
        limit: limit.limit,
        windowSeconds: limit.windowSeconds,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_UNAVAILABLE",
        `Run admission limiter request failed (${response.status}).`,
        503,
        true,
        correlationId,
        {
          limiterStatus: response.status,
          limiterError: errorText,
        },
      );
    }

    const body = (await response.json()) as unknown;
    if (!isAdmissionDecision(body)) {
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_INVALID_RESPONSE",
        "Run admission limiter returned an invalid response.",
        503,
        true,
        correlationId,
      );
    }

    return body;
  }

  private async acquireConcurrencyLease(
    leaseId: string,
    constraints: ConcurrencyConstraint[],
    correlationId: string,
  ): Promise<ConcurrencyAcquireDecision> {
    const response = await this.requestLimiter(
      "/acquire-concurrency",
      {
        leaseId,
        leaseTtlSeconds: readPositiveInt(
          this.env.ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS,
          DEFAULT_ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS,
        ),
        constraints,
      },
      correlationId,
    );
    if (!isConcurrencyAcquireDecision(response)) {
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_INVALID_RESPONSE",
        "Run admission limiter returned an invalid concurrency response.",
        503,
        true,
        correlationId,
      );
    }
    return response;
  }

  private async releaseConcurrencyLease(
    leaseId: string,
    correlationId: string,
  ): Promise<void> {
    const response = await this.requestLimiter(
      "/release-concurrency",
      { leaseId },
      correlationId,
    );
    if (!isConcurrencyReleaseDecision(response)) {
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_INVALID_RESPONSE",
        "Run admission limiter returned an invalid release response.",
        503,
        true,
        correlationId,
      );
    }
  }

  private async requestLimiter(
    path: "/acquire-concurrency" | "/release-concurrency",
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

    const id = this.env.RUN_ADMISSION_LIMITER.idFromName(
      CONCURRENCY_LIMITER_SCOPE,
    );
    const stub = this.env.RUN_ADMISSION_LIMITER.get(id);
    const response = await stub.fetch(`https://run-admission-limiter${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new DomainError(
        "RUN_ADMISSION_LIMITER_UNAVAILABLE",
        `Run admission limiter request failed (${response.status}).`,
        503,
        true,
        correlationId,
        {
          limiterStatus: response.status,
          limiterError: errorText,
        },
      );
    }

    return (await response.json()) as unknown;
  }

  private buildConcurrencyConstraints(
    input: RunAdmissionInput,
  ): ConcurrencyConstraint[] {
    const sessionScope = normalizeScopeValue(input.sessionId);
    const userScope = normalizeScopeValue(input.userId);
    const workspaceScope = normalizeScopeValue(input.workspaceId);
    const fallbackScope = normalizeScopeValue(input.clientFingerprint);
    const anonymous = userScope === "unknown" || workspaceScope === "unknown";
    const anonymousLimit = readPositiveInt(
      this.env.ACTIVE_EXPENSIVE_RUNS_ANONYMOUS_MAX,
      DEFAULT_ACTIVE_EXPENSIVE_RUNS_ANONYMOUS_MAX,
    );

    return [
      {
        bucket: "concurrent_expensive_run_session",
        scopeKey:
          sessionScope === "unknown"
            ? `session-fingerprint:${fallbackScope}`
            : `session:${sessionScope}`,
        limit: readPositiveInt(
          this.env.ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX,
          DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX,
        ),
      },
      {
        bucket: "concurrent_expensive_run_user",
        scopeKey:
          userScope === "unknown"
            ? `user-fingerprint:${fallbackScope}`
            : `user:${userScope}`,
        limit: anonymous
          ? anonymousLimit
          : readPositiveInt(
              this.env.ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX,
              DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX,
            ),
      },
      {
        bucket: "concurrent_expensive_run_workspace",
        scopeKey:
          workspaceScope === "unknown"
            ? `workspace-fingerprint:${fallbackScope}`
            : `workspace:${workspaceScope}`,
        limit: anonymous
          ? anonymousLimit
          : readPositiveInt(
              this.env.ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX,
              DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX,
            ),
      },
    ];
  }

  private buildScope(input: RunAdmissionInput): string {
    const userId = normalizeScopeValue(input.userId);
    const workspaceId = normalizeScopeValue(input.workspaceId);
    if (userId === "unknown" || workspaceId === "unknown") {
      const fallbackFingerprint = normalizeScopeValue(input.clientFingerprint);
      return `user:${userId}:workspace:${workspaceId}:fingerprint:${fallbackFingerprint}`;
    }
    return `user:${userId}:workspace:${workspaceId}`;
  }

  private createLeaseId(): string {
    const randomBytes = new Uint8Array(8);
    crypto.getRandomValues(randomBytes);
    const suffix = Array.from(randomBytes)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return `lease_${Date.now()}_${suffix}`;
  }

}

function readPositiveInt(value: string | undefined | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeScopeValue(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}


function isAdmissionDecision(value: unknown): value is RateLimitDecision {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.allowed === "boolean" &&
    typeof candidate.retryAfterSeconds === "number" &&
    Number.isFinite(candidate.retryAfterSeconds) &&
    candidate.retryAfterSeconds >= 0
  );
}

function isConcurrencyAcquireDecision(
  value: unknown,
): value is ConcurrencyAcquireDecision {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const leaseId = candidate.leaseId;
  const blockedBucket = candidate.blockedBucket;
  return (
    typeof candidate.allowed === "boolean" &&
    typeof candidate.retryAfterSeconds === "number" &&
    Number.isFinite(candidate.retryAfterSeconds) &&
    candidate.retryAfterSeconds >= 0 &&
    (leaseId === undefined || typeof leaseId === "string") &&
    (blockedBucket === undefined || typeof blockedBucket === "string")
  );
}

function isConcurrencyReleaseDecision(
  value: unknown,
): value is ConcurrencyReleaseDecision {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.released === "boolean";
}
