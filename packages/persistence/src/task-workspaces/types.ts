import type { JsonValue } from "@repo/shared-types";
import {
  type LeaseId,
  type RunAttemptId,
  type TaskCheckout,
  type TaskCheckoutId,
  type WorkspaceId,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotId,
} from "@repo/platform-protocol";

export interface WorkspaceSnapshotRepository {
  issueSnapshotCheckout(
    snapshot: WorkspaceSnapshot,
    checkout: TaskCheckout,
  ): Promise<{
    readonly snapshot: WorkspaceSnapshot;
    readonly checkout: TaskCheckout;
  }>;
  createSnapshot(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot>;
  getBySnapshotId(
    snapshotId: WorkspaceSnapshotId,
  ): Promise<WorkspaceSnapshot | null>;
}

export interface TaskCheckoutRepository {
  createCheckout(checkout: TaskCheckout): Promise<TaskCheckout>;
  getByCheckoutId(checkoutId: TaskCheckoutId): Promise<TaskCheckout | null>;
  getByRunAttemptId(runAttemptId: RunAttemptId): Promise<TaskCheckout | null>;
  getByLeaseId(leaseId: LeaseId): Promise<TaskCheckout | null>;
  activate(checkoutId: TaskCheckoutId): Promise<TaskCheckout>;
  replaceLease(input: ReplaceTaskCheckoutLeaseInput): Promise<TaskCheckout>;
  settle(input: SettleTaskCheckoutInput): Promise<TaskCheckout>;
}

export type TaskWorkspaceRepository = WorkspaceSnapshotRepository &
  TaskCheckoutRepository;

export type SettleTaskCheckoutInput =
  | {
      readonly checkoutId: TaskCheckoutId;
      readonly status: "settled";
      readonly settledAt: string;
      readonly failureCode: null;
    }
  | {
      readonly checkoutId: TaskCheckoutId;
      readonly status: "failed";
      readonly settledAt: string;
      readonly failureCode: string;
    };

export interface ReplaceTaskCheckoutLeaseInput {
  readonly checkoutId: TaskCheckoutId;
  readonly expectedLeaseId: LeaseId;
  readonly expectedGeneration: number;
  readonly nextLeaseId: LeaseId;
  readonly nextSandboxId: string;
  readonly nextGeneration: number;
}

export class TaskWorkspacePersistenceError extends Error {
  constructor(
    readonly code:
      | "workspace_snapshot_conflict"
      | "workspace_snapshot_not_found"
      | "task_checkout_conflict"
      | "task_checkout_not_found"
      | "task_checkout_scope_mismatch"
      | "task_checkout_transition_conflict"
      | "task_checkout_transition_invalid"
      | "task_checkout_recovery_required",
    message: string,
    readonly context: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "TaskWorkspacePersistenceError";
  }
}

export interface TaskCheckoutBinding {
  readonly checkoutId: TaskCheckoutId;
  readonly snapshotId: WorkspaceSnapshotId;
  readonly workspaceId: WorkspaceId;
  readonly runAttemptId: RunAttemptId;
  readonly leaseId: LeaseId;
}

/** Private issuance custody on the existing checkout row, never a ready DTO. */
export type TaskCheckoutIssuanceReservation = Pick<
  TaskCheckout,
  | "checkoutId"
  | "snapshotId"
  | "workspaceId"
  | "threadId"
  | "turnId"
  | "runAttemptId"
  | "filesystemRoot"
  | "gitDir"
  | "indexFile"
  | "workingBranch"
  | "startTreeId"
  | "createdAt"
> & { readonly issuanceToken: string };

export interface PersistedTaskCheckoutExecutionDomain {
  readonly value: JsonValue;
  readonly digest: string;
}

/** A legacy result requires a positive read of the canonical unmarked row. */
export type TaskCheckoutExecutionDomainState =
  | { readonly kind: "legacy" }
  | {
      readonly kind: "marked";
      readonly domain: PersistedTaskCheckoutExecutionDomain;
    };

export interface TaskCheckoutIssuanceRepository {
  freezeIssuanceOriginalReference?(checkoutId: TaskCheckoutId, issuanceToken: string, reference: JsonValue): Promise<void>;
  getCheckoutOriginalReference?(checkoutId: TaskCheckoutId): Promise<JsonValue>;
  reserveIssuance(
    snapshot: WorkspaceSnapshot,
    reservation: TaskCheckoutIssuanceReservation,
  ): Promise<void>;
  beginIssuanceCallback(
    checkoutId: TaskCheckoutId,
    issuanceToken: string,
  ): Promise<void>;
  freezeIssuanceDomain(
    checkoutId: TaskCheckoutId,
    issuanceToken: string,
    domain: PersistedTaskCheckoutExecutionDomain,
  ): Promise<void>;
  completeIssuance(
    checkout: TaskCheckout,
    issuanceToken: string,
  ): Promise<TaskCheckout>;
  markIssuanceUnknown(
    checkoutId: TaskCheckoutId,
    issuanceToken: string,
  ): Promise<void>;
  getCheckoutExecutionDomain(
    checkoutId: TaskCheckoutId,
  ): Promise<PersistedTaskCheckoutExecutionDomain>;
  getCheckoutExecutionDomainState(
    checkoutId: TaskCheckoutId,
  ): Promise<TaskCheckoutExecutionDomainState>;
}
