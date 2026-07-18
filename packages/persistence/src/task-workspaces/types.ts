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

export class TaskWorkspacePersistenceError extends Error {
  constructor(
    readonly code:
      | "workspace_snapshot_conflict"
      | "workspace_snapshot_not_found"
      | "task_checkout_conflict"
      | "task_checkout_not_found"
      | "task_checkout_scope_mismatch"
      | "task_checkout_transition_conflict"
      | "task_checkout_transition_invalid",
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
