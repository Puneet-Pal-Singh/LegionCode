import { describe, expect, it } from "vitest";
import {
  TaskCheckoutSchema,
  WorkspaceSnapshotSchema,
} from "./task-workspaces.js";

const timestamp = "2026-07-18T12:00:00.000Z";
const digest = "a".repeat(64);
const commitId = "b".repeat(40);
const treeId = "c".repeat(40);

const snapshotInput = {
  kind: "workspace_snapshot",
  snapshotId: "wsnap_snapshot1",
  workspaceId: "wrk_workspace1",
  repository: {
    provider: "github",
    owner: "Puneet-Pal-Singh",
    name: "LegionCode",
    canonicalUrl: "https://github.com/Puneet-Pal-Singh/LegionCode",
  },
  authorizedCommitId: commitId,
  authorizedTreeId: treeId,
  manifestDigest: digest,
  configDigest: "d".repeat(64),
  capturedAt: timestamp,
  provenance: {
    kind: "authorized_repository",
    requestedRef: "dev",
    resolvedRef: "refs/heads/dev",
    authorizedByUserId: "usr_user123",
    authorizationContextDigest: "e".repeat(64),
  },
} as const;

const checkoutInput = {
  kind: "task_checkout",
  checkoutId: "checkout_task01",
  snapshotId: "wsnap_snapshot1",
  workspaceId: "wrk_workspace1",
  threadId: "thr_thread01",
  turnId: "trn_turn0001",
  runAttemptId: "attempt_attempt1",
  secureSessionId: "sess_secure001",
  leaseId: "lease_lease001",
  sandboxId: "sb-a1b2c3d4",
  filesystemRoot: "/workspace/checkouts/checkout_task01",
  gitDir: "/workspace/git/checkout_task01",
  indexFile: "/workspace/indexes/checkout_task01.index",
  workingBranch: "task/checkout-task01",
  startTreeId: treeId,
  generation: 1,
  createdAt: timestamp,
  status: "active",
  settledAt: null,
  failureCode: null,
} as const;

describe("isolated task workspace protocol", () => {
  it("accepts and freezes an immutable authorized workspace snapshot", () => {
    const snapshot = WorkspaceSnapshotSchema.parse(snapshotInput);

    expect(snapshot.snapshotId).toBe("wsnap_snapshot1");
    expect(snapshot.provenance.kind).toBe("authorized_repository");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.repository)).toBe(true);
  });

  it("rejects snapshots without full authorized Git identities or digests", () => {
    expect(() =>
      WorkspaceSnapshotSchema.parse({
        ...snapshotInput,
        authorizedCommitId: "shortsha",
      }),
    ).toThrow();
    expect(() =>
      WorkspaceSnapshotSchema.parse({
        ...snapshotInput,
        configDigest: "not-a-digest",
      }),
    ).toThrow();
  });

  it("accepts a task checkout bound to one complete canonical task scope", () => {
    const checkout = TaskCheckoutSchema.parse(checkoutInput);

    expect(checkout).toMatchObject({
      workspaceId: "wrk_workspace1",
      threadId: "thr_thread01",
      turnId: "trn_turn0001",
      runAttemptId: "attempt_attempt1",
      leaseId: "lease_lease001",
      status: "active",
      generation: 1,
    });
  });

  it("enforces status-specific settlement and failure fields", () => {
    expect(() =>
      TaskCheckoutSchema.parse({
        ...checkoutInput,
        status: "settled",
      }),
    ).toThrow();

    expect(
      TaskCheckoutSchema.parse({
        ...checkoutInput,
        status: "failed",
        settledAt: timestamp,
        failureCode: "CHECKOUT_CONTAINER_LOST",
      }).failureCode,
    ).toBe("CHECKOUT_CONTAINER_LOST");
  });

  it("rejects unsafe roots, refs, generations, and shared Git paths", () => {
    expect(() =>
      TaskCheckoutSchema.parse({
        ...checkoutInput,
        filesystemRoot: "relative/root",
      }),
    ).toThrow();
    expect(() =>
      TaskCheckoutSchema.parse({
        ...checkoutInput,
        filesystemRoot: "/workspace/checkouts/../shared",
      }),
    ).toThrow();
    expect(() =>
      TaskCheckoutSchema.parse({
        ...checkoutInput,
        workingBranch: "../dev",
      }),
    ).toThrow();
    expect(() =>
      TaskCheckoutSchema.parse({
        ...checkoutInput,
        generation: -1,
      }),
    ).toThrow();
    expect(() =>
      TaskCheckoutSchema.parse({
        ...checkoutInput,
        gitDir: checkoutInput.filesystemRoot,
      }),
    ).toThrow();
  });
});
