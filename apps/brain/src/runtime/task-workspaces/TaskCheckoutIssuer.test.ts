import { describe, expect, it, vi } from "vitest";
import type {
  TaskWorkspaceRepository,
  TaskCheckoutIssuanceRepository,
  TaskCheckoutIssuanceReservation,
  PersistedTaskCheckoutExecutionDomain,
} from "@repo/persistence";
import {
  TaskCheckoutSchema,
  WorkspaceSnapshotSchema,
  type TaskCheckout,
  type WorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { ExecuteRunPayload } from "../parsing/ExecuteRunPayloadSchema";
import type { Env } from "../../types/ai";
import {
  TaskCheckoutIssuer,
  type SecureExecutionSessionFactory,
  type TaskCheckoutIssueOptions,
} from "./TaskCheckoutIssuer";

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
    authorizedByUserId: "usr_user-001",
    authorizationContextDigest: "e".repeat(64),
  },
});

describe("TaskCheckoutIssuer", () => {
  it("issues three same-model chats with distinct checkout and lease roots", async () => {
    const repository = createRepository();
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      {
        capture: vi.fn(async (input) =>
          WorkspaceSnapshotSchema.parse({
            ...snapshot,
            snapshotId: `wsnap_snapshot${input.workspaceId.at(-1)}`,
            workspaceId: input.workspaceId,
            repository: {
              ...snapshot.repository,
              name: input.repository.repo,
              canonicalUrl: `https://github.com/${input.repository.owner}/${input.repository.repo}`,
            },
          }),
        ),
      },
      repository,
      ({ workspaceScope }) => ({
        acquire: vi.fn(async () => ({
          sessionId: `sess_${workspaceScope.runAttemptId}`,
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: `lease_${workspaceScope.runAttemptId}`,
            sandboxId: `sb-attempt-${workspaceScope.runAttemptId.at(-1)}`,
            generation: 0,
          },
        })),
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release: vi.fn(async () => undefined),
      }),
    );

    const issued = await Promise.all([
      issuer.issue(
        payloadFor(1, "gpt-5.6-luna"),
        issueOptions(payloadFor(1, "gpt-5.6-luna")),
      ),
      issuer.issue(
        payloadFor(2, "gpt-5.6-luna"),
        issueOptions(payloadFor(2, "gpt-5.6-luna")),
      ),
      issuer.issue(
        payloadFor(3, "gpt-5.6-luna"),
        issueOptions(payloadFor(3, "gpt-5.6-luna")),
      ),
    ]);

    expect(
      new Set(issued.map(({ checkout }) => checkout.checkoutId)).size,
    ).toBe(3);
    expect(
      new Set(issued.map(({ checkout }) => checkout.filesystemRoot)).size,
    ).toBe(3);
    expect(new Set(issued.map(({ checkout }) => checkout.leaseId)).size).toBe(
      3,
    );
    for (const { checkout, workspaceScope } of issued) {
      expect(workspaceScope).toMatchObject({
        workspaceId: checkout.workspaceId,
        threadId: checkout.threadId,
        turnId: checkout.turnId,
        runAttemptId: checkout.runAttemptId,
        root: checkout.filesystemRoot,
      });
    }
  });

  it("binds one canonical checkout root to the secure lease and snapshot", async () => {
    const repository = createRepository();
    const release = vi.fn(async () => undefined);
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture: vi.fn(async () => snapshot) },
      repository,
      ({ workspaceScope }) => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess_secure001",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
          },
        })),
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release,
        workspaceScope,
      }),
    );

    const issued = await issuer.issue(payload(), issueOptions());

    expect(issued.checkout).toMatchObject({
      snapshotId: snapshot.snapshotId,
      workspaceId: snapshot.workspaceId,
      secureSessionId: "sess_secure001",
      leaseId: "lease_secure01",
      sandboxId: "sb-secure01",
      startTreeId: snapshot.authorizedTreeId,
      generation: 0,
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

  it("rotates a bearer and reuses the exact persisted checkout after restart", async () => {
    const repository = createRepository();
    const capture = vi.fn(async () => snapshot);
    const sessionFactory = vi.fn(
      (input: Parameters<SecureExecutionSessionFactory>[0]) => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess_secure001",
          token: "rotated-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
          },
        })),
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release: vi.fn(async () => undefined),
        persistedReference: input.persistedReference,
      }),
    );
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture },
      repository,
      sessionFactory,
    );
    const first = await issuer.issue(payload(), issueOptions());
    repository.getByRunAttemptId.mockResolvedValueOnce(first.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);

    const resumed = await issuer.issue(payload(), issueOptions());

    expect(resumed.checkout).toEqual(first.checkout);
    expect(capture).toHaveBeenCalledOnce();
    expect(repository.issueSnapshotCheckout).toHaveBeenCalledOnce();
    expect(sessionFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        persistedReference: {
          secureSessionId: first.checkout.secureSessionId,
          leaseId: first.checkout.leaseId,
          sandboxId: first.checkout.sandboxId,
          generation: first.checkout.generation,
          executionDomainDigest: (
            await repository.getCheckoutExecutionDomain(
              first.checkout.checkoutId,
            )
          ).digest,
        },
      }),
    );
  });

  it("atomically adopts one secure replacement generation without changing checkout provenance", async () => {
    const repository = createRepository();
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "sess_secure001",
        token: "initial-token",
        expiresAt: Date.now() + 60_000,
        lease: {
          leaseId: "lease_secure01",
          sandboxId: "sb-secure01",
          generation: 0,
        },
      })
      .mockResolvedValueOnce({
        sessionId: "sess_secure001",
        token: "replacement-token",
        expiresAt: Date.now() + 60_000,
        lease: {
          leaseId: "lease_secure02",
          sandboxId: "sb-secure02",
          generation: 1,
        },
      });
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture: vi.fn(async () => snapshot) },
      repository,
      () => ({
        acquire,
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release: vi.fn(async () => undefined),
      }),
    );
    const first = await issuer.issue(payload(), issueOptions());
    repository.getByRunAttemptId.mockResolvedValueOnce(first.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);
    const replacedCheckout = TaskCheckoutSchema.parse({
      ...first.checkout,
      leaseId: "lease_secure02",
      sandboxId: "sb-secure02",
      generation: 1,
    });
    repository.replaceLease.mockResolvedValueOnce(replacedCheckout);

    const resumed = issuer.issue(payload(), issueOptions());

    await expect(resumed).rejects.toMatchObject({
      code: "TASK_CHECKOUT_RESUME_UNAVAILABLE",
    });
    expect(first.checkout.checkoutId).toBe(replacedCheckout.checkoutId);
    expect(first.checkout.snapshotId).toBe(replacedCheckout.snapshotId);
    expect(first.checkout.filesystemRoot).toBe(replacedCheckout.filesystemRoot);
    expect(repository.replaceLease).not.toHaveBeenCalled();
  });

  it("releases only the acquired secure session when atomic issuance fails", async () => {
    const repository = createRepository();
    repository.getByRunAttemptId.mockResolvedValue(null);
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
          sessionId: "sess_secure001",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
          },
        })),
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release,
      }),
    );

    const failureCleanup = vi.fn();
    await expect(
      issuer.issue(payload(), { ...issueOptions(), failureCleanup }),
    ).rejects.toThrow("database unavailable");
    expect(release).toHaveBeenCalledOnce();
    // Neither a void release (including its HTTP404 path) nor checkout
    // absence is the exact physical receipt needed to release admission.
    expect(failureCleanup).not.toHaveBeenCalled();
    failureCleanup.mockClear();
    await expect(
      issuer.issue(
        {
          ...payload(),
          input: { ...payload().input, repositoryContext: undefined },
        },
        { ...issueOptions(), failureCleanup },
      ),
    ).rejects.toMatchObject({ code: "TASK_CHECKOUT_INPUT_REQUIRED" });
    expect(failureCleanup).toHaveBeenCalledTimes(1);
    expect(failureCleanup).toHaveBeenCalledWith({ kind: "no_exposure" });

    // A rejected acquire can have reached the remote owner. A successful no-op
    // release after that rejection is not a positive cleanup receipt.
    failureCleanup.mockClear();
    const ambiguous = new TaskCheckoutIssuer(
      {} as Env,
      { capture: async () => snapshot },
      createRepository(),
      () => ({
        acquire: async () => {
          throw new Error("acquire response lost");
        },
        recoverAfterSandboxLoss: async () => {
          throw new Error("not expected");
        },
        release: async () => undefined,
      }),
    );
    await expect(
      ambiguous.issue(payload(), { ...issueOptions(), failureCleanup }),
    ).rejects.toThrow("acquire response lost");
    expect(failureCleanup).not.toHaveBeenCalled();
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
          sessionId: "sess_secure001",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
          },
        })),
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release: vi.fn(async () => {
          throw new Error("secure delete failed");
        }),
      }),
    );

    const failureCleanup = vi.fn();
    await expect(
      issuer.issue(payload(), { ...issueOptions(), failureCleanup }),
    ).rejects.toMatchObject({
      code: "TASK_CHECKOUT_COMPENSATION_FAILED",
      status: 503,
      retryable: true,
    });
    expect(failureCleanup).not.toHaveBeenCalled();
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

function payloadFor(index: number, modelId: string): ExecuteRunPayload {
  const base = payload();
  const workspaceId = `wrk_workspace${index}`;
  const sessionId = `session-control-${index}`;
  return {
    ...base,
    runId: `run_issuer0${index}`,
    workspaceId,
    sessionId,
    correlationId: `corr-issuer-${index}`,
    identity: {
      sessionId,
      workspaceId,
      threadId: `thr_thread0${index}`,
      turnId: `trn_turn000${index}`,
      runAttemptId: `attempt_attempt${index}`,
    },
    input: {
      ...base.input,
      sessionId,
      providerId: "openai",
      modelId,
      repositoryContext: {
        owner: "acme",
        repo: `repo-${index}`,
        branch: "dev",
      },
    },
  } as ExecuteRunPayload;
}

function issueOptions(input = payload()): TaskCheckoutIssueOptions {
  return {
    beforeSessionAcquire: async ({ workspaceScope }) => ({
      version: 1,
      domain: "legioncode_native",
      scope: {
        userId: input.userId!,
        brainSessionId: input.sessionId,
        runId: input.runId,
        workspaceId: workspaceScope.workspaceId,
        threadId: workspaceScope.threadId,
        turnId: workspaceScope.turnId,
        runAttemptId: workspaceScope.runAttemptId,
      },
    }),
  };
}

function createRepository() {
  const reservations = new Map<
    string,
    {
      snapshot: WorkspaceSnapshot;
      reservation: TaskCheckoutIssuanceReservation;
    }
  >();
  const domains = new Map<string, PersistedTaskCheckoutExecutionDomain>();
  const issueSnapshotCheckout = vi.fn(
    async (issuedSnapshot: WorkspaceSnapshot, checkout: TaskCheckout) => ({
      snapshot: issuedSnapshot,
      checkout,
    }),
  );
  return {
    issueSnapshotCheckout,
    reserveIssuance: vi.fn(
      async (
        issuedSnapshot: WorkspaceSnapshot,
        reservation: TaskCheckoutIssuanceReservation,
      ) => {
        reservations.set(reservation.checkoutId, {
          snapshot: issuedSnapshot,
          reservation,
        });
      },
    ),
    beginIssuanceCallback: vi.fn(async () => undefined),
    freezeIssuanceDomain: vi.fn(
      async (
        checkoutId: string,
        _token: string,
        domain: PersistedTaskCheckoutExecutionDomain,
      ) => {
        domains.set(checkoutId, domain);
      },
    ),
    completeIssuance: vi.fn(
      async (checkout: TaskCheckout) =>
        (
          await issueSnapshotCheckout(
            reservations.get(checkout.checkoutId)!.snapshot,
            checkout,
          )
        ).checkout,
    ),
    markIssuanceUnknown: vi.fn(async () => undefined),
    getCheckoutExecutionDomain: vi.fn(
      async (checkoutId: string) => domains.get(checkoutId)!,
    ),
    createSnapshot: vi.fn(),
    getBySnapshotId: vi.fn(),
    createCheckout: vi.fn(),
    getByCheckoutId: vi.fn(),
    getByRunAttemptId: vi.fn(),
    getByLeaseId: vi.fn(),
    activate: vi.fn(),
    replaceLease: vi.fn(),
    settle: vi.fn(),
  } satisfies TaskWorkspaceRepository & TaskCheckoutIssuanceRepository;
}
