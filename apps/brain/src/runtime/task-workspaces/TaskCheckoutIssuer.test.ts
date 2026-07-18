import { describe, expect, it, vi } from "vitest";
import type { TaskWorkspaceRepository } from "@repo/persistence";
import {
  WorkspaceSnapshotSchema,
  type TaskCheckout,
  type WorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { ExecuteRunPayload } from "../parsing/ExecuteRunPayloadSchema";
import type { Env } from "../../types/ai";
import { TaskCheckoutIssuer } from "./TaskCheckoutIssuer";

const snapshot = WorkspaceSnapshotSchema.parse({
  kind: "workspace_snapshot",
  snapshotId: "wsnap_snapshot1",
  workspaceId: "wrk_workspace1",
  repository: {
    provider: "github",
    owner: "acme",
    name: "repo",
    canonicalUrl: "https://github.com/acme/repo",
  },
  authorizedCommitId: "a".repeat(40),
  authorizedTreeId: "b".repeat(40),
  manifestDigest: "c".repeat(64),
  configDigest: "d".repeat(64),
  capturedAt: "2026-07-18T12:00:00.000Z",
  provenance: {
    kind: "authorized_repository",
    requestedRef: "dev",
    resolvedRef: "refs/heads/dev",
    authorizedByUserId: "usr_user001",
    authorizationContextDigest: "e".repeat(64),
  },
});

describe("TaskCheckoutIssuer", () => {
  it("binds one canonical checkout root to the secure lease and snapshot", async () => {
    const repository = createRepository();
    const release = vi.fn(async () => undefined);
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture: vi.fn(async () => snapshot) },
      repository,
      ({ workspaceScope }) => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess-secure",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
          },
        })),
        release,
        workspaceScope,
      }),
    );

    const issued = await issuer.issue(payload());

    expect(issued.checkout).toMatchObject({
      snapshotId: snapshot.snapshotId,
      workspaceId: snapshot.workspaceId,
      leaseId: "lease_secure01",
      sandboxId: "sb-secure01",
      startTreeId: snapshot.authorizedTreeId,
      generation: 1,
      status: "ready",
    });
    expect(issued.checkout.filesystemRoot).toBe(
      `/home/sandbox/checkouts/${issued.checkout.checkoutId}`,
    );
    expect(issued.workspaceScope.root).toBe(issued.checkout.filesystemRoot);
    expect(repository.issueSnapshotCheckout).toHaveBeenCalledWith(
      snapshot,
      issued.checkout,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("releases only the acquired secure session when atomic issuance fails", async () => {
    const repository = createRepository();
    repository.issueSnapshotCheckout.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const release = vi.fn(async () => undefined);
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture: vi.fn(async () => snapshot) },
      repository,
      () => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess-secure",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
          },
        })),
        release,
      }),
    );

    await expect(issuer.issue(payload())).rejects.toThrow(
      "database unavailable",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("surfaces a typed capacity recovery failure when issuance compensation fails", async () => {
    const repository = createRepository();
    repository.issueSnapshotCheckout.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture: vi.fn(async () => snapshot) },
      repository,
      () => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess-secure",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
          },
        })),
        release: vi.fn(async () => {
          throw new Error("secure delete failed");
        }),
      }),
    );

    await expect(issuer.issue(payload())).rejects.toMatchObject({
      code: "TASK_CHECKOUT_COMPENSATION_FAILED",
      status: 503,
      retryable: true,
    });
  });
});

function payload(): ExecuteRunPayload {
  return {
    runId: "run_issuer01",
    identity: {
      sessionId: "session-control",
      workspaceId: "wrk_workspace1",
      threadId: "thr_thread01",
      turnId: "trn_turn0001",
      runAttemptId: "attempt_attempt1",
    },
    userId: "user-001",
    workspaceId: "wrk_workspace1",
    sessionId: "session-control",
    correlationId: "corr-issuer",
    input: {
      mode: "auto",
      agentType: "coding",
      prompt: "read the repository",
      sessionId: "session-control",
      orchestratorBackend: "execution-engine-v1",
      executionBackend: "cloudflare_sandbox",
      harnessMode: "platform_owned",
      authMode: "oauth",
      repositoryContext: {
        owner: "acme",
        repo: "repo",
        branch: "dev",
      },
    },
    messages: [{ role: "user", content: "read the repository" }],
  } as ExecuteRunPayload;
}

function createRepository() {
  const issueSnapshotCheckout = vi.fn(
    async (issuedSnapshot: WorkspaceSnapshot, checkout: TaskCheckout) => ({
      snapshot: issuedSnapshot,
      checkout,
    }),
  );
  return {
    issueSnapshotCheckout,
    createSnapshot: vi.fn(),
    getBySnapshotId: vi.fn(),
    createCheckout: vi.fn(),
    getByCheckoutId: vi.fn(),
    getByRunAttemptId: vi.fn(),
    getByLeaseId: vi.fn(),
    activate: vi.fn(),
    settle: vi.fn(),
  } satisfies TaskWorkspaceRepository;
}
