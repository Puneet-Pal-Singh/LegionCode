import type { RunMode, WorkflowIntent } from "@repo/shared-types";
import { DomainError } from "../domain/errors";

export const RUN_ADMISSION_BUCKETS = {
  submission: "run_submission",
  mutationSubmission: "mutation_run_submission",
  session: "concurrent_expensive_run_session",
  user: "concurrent_expensive_run_user",
  workspace: "concurrent_expensive_run_workspace",
  cloudflareSandbox: "cloudflare_sandbox_capacity",
} as const;

export type RunAdmissionBucket =
  (typeof RUN_ADMISSION_BUCKETS)[keyof typeof RUN_ADMISSION_BUCKETS];
export type ConcurrencyBucket =
  | typeof RUN_ADMISSION_BUCKETS.session
  | typeof RUN_ADMISSION_BUCKETS.user
  | typeof RUN_ADMISSION_BUCKETS.workspace
  | typeof RUN_ADMISSION_BUCKETS.cloudflareSandbox;

export interface RunAdmissionIdentity {
  userId: string;
  workspaceId: string;
  threadId: string;
  runAttemptId: string;
}

export interface RunAdmissionInput extends RunAdmissionIdentity {
  mode?: RunMode;
  workflowIntent?: WorkflowIntent;
}

export interface AdmissionConstraint {
  bucket: ConcurrencyBucket;
  scopeKey: string;
  limit: number;
}

export interface AdmissionPolicy {
  rateLimit: {
    bucket: typeof RUN_ADMISSION_BUCKETS.submission | typeof RUN_ADMISSION_BUCKETS.mutationSubmission;
    limit: number;
    windowSeconds: number;
  };
  concurrencyConstraints: AdmissionConstraint[];
  leaseTtlSeconds: number;
}

const DEFAULT_RUN_SUBMISSION_LIMIT = 60;
const DEFAULT_RUN_SUBMISSION_WINDOW_SECONDS = 600;
const DEFAULT_MUTATION_RUN_SUBMISSION_LIMIT = 20;
const DEFAULT_MUTATION_RUN_SUBMISSION_WINDOW_SECONDS = 600;
const DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX = 1;
const DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX = 2;
const DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX = 3;
const DEFAULT_CLOUDFLARE_SANDBOX_MAX_CONCURRENT_RUNS = 2;
const DEFAULT_ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS = 900;

export function buildAdmissionPolicy(
  input: RunAdmissionInput,
  env: {
    RUN_SUBMISSION_RATE_LIMIT_MAX?: string;
    RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS?: string;
    MUTATION_RUN_SUBMISSION_RATE_LIMIT_MAX?: string;
    MUTATION_RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS?: string;
    ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX?: string;
    ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX?: string;
    ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX?: string;
    CLOUDFLARE_SANDBOX_MAX_CONCURRENT_RUNS?: string;
    ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS?: string;
  },
): AdmissionPolicy {
  const mutationCapable = isMutationCapable(input);
  return {
    rateLimit: mutationCapable
      ? {
          bucket: RUN_ADMISSION_BUCKETS.mutationSubmission,
          limit: readPositiveInt(
            env.MUTATION_RUN_SUBMISSION_RATE_LIMIT_MAX,
            DEFAULT_MUTATION_RUN_SUBMISSION_LIMIT,
          ),
          windowSeconds: readPositiveInt(
            env.MUTATION_RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
            DEFAULT_MUTATION_RUN_SUBMISSION_WINDOW_SECONDS,
          ),
        }
      : {
          bucket: RUN_ADMISSION_BUCKETS.submission,
          limit: readPositiveInt(
            env.RUN_SUBMISSION_RATE_LIMIT_MAX,
            DEFAULT_RUN_SUBMISSION_LIMIT,
          ),
          windowSeconds: readPositiveInt(
            env.RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
            DEFAULT_RUN_SUBMISSION_WINDOW_SECONDS,
          ),
        },
    concurrencyConstraints: [
      {
        bucket: RUN_ADMISSION_BUCKETS.session,
        scopeKey: `thread:${input.threadId}`,
        limit: readPositiveInt(
          env.ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX,
          DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX,
        ),
      },
      {
        bucket: RUN_ADMISSION_BUCKETS.user,
        scopeKey: `user:${input.userId}`,
        limit: readPositiveInt(
          env.ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX,
          DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX,
        ),
      },
      {
        bucket: RUN_ADMISSION_BUCKETS.workspace,
        scopeKey: `workspace:${input.workspaceId}`,
        limit: readPositiveInt(
          env.ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX,
          DEFAULT_ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX,
        ),
      },
      {
        bucket: RUN_ADMISSION_BUCKETS.cloudflareSandbox,
        scopeKey: "platform:cloudflare-sandbox",
        limit: readPositiveInt(
          env.CLOUDFLARE_SANDBOX_MAX_CONCURRENT_RUNS,
          DEFAULT_CLOUDFLARE_SANDBOX_MAX_CONCURRENT_RUNS,
        ),
      },
    ],
    leaseTtlSeconds: readPositiveInt(
      env.ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS,
      DEFAULT_ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS,
    ),
  };
}

export function assertCanonicalRunAdmissionIdentity(
  input: Partial<RunAdmissionIdentity>,
  correlationId: string,
): RunAdmissionIdentity {
  const fields = ["userId", "workspaceId", "threadId", "runAttemptId"] as const;
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new DomainError(
        "RUN_ADMISSION_IDENTITY_MISSING",
        `Canonical ${field} is required before run admission.`,
        400,
        false,
        correlationId,
        { field },
      );
    }
  }
  return {
    userId: input.userId!.trim(),
    workspaceId: input.workspaceId!.trim(),
    threadId: input.threadId!.trim(),
    runAttemptId: input.runAttemptId!.trim(),
  };
}

function isMutationCapable(input: RunAdmissionInput): boolean {
  return (
    input.mode !== "plan" &&
    input.workflowIntent !== "explore" &&
    input.workflowIntent !== "review"
  );
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
