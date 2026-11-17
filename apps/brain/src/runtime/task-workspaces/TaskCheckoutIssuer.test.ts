import { createHash } from "node:crypto";
import type {
  TaskCheckoutIssuanceRepository,
  PersistedTaskCheckoutExecutionDomain,
} from "@repo/persistence";
import { describe, expect, it, vi } from "vitest";
import type { TaskWorkspaceRepository } from "@repo/persistence";
import {
  TaskCheckoutSchema,
  RunAttemptIdSchema,
  WorkspaceSnapshotSchema,
  type TaskCheckout,
  type WorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { ExecuteRunPayload } from "../parsing/ExecuteRunPayloadSchema";
import type { Env } from "../../types/ai";
import {
  TaskCheckoutIssuer,
  type SecureExecutionSessionFactory,
  type BeforeTaskCheckoutSessionAcquire,
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
      ({ workspaceScope, executionDomain }) => ({
        acquire: vi.fn(async () => ({
          sessionId: `sess_${workspaceScope.runAttemptId}`,
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: `lease_${workspaceScope.runAttemptId}`,
            sandboxId: `sb-attempt-${workspaceScope.runAttemptId.at(-1)}`,
            generation: 0,
            ...(executionDomain
              ? { executionDomainDigest: await digestFor(executionDomain) }
              : {}),
          },
        })),
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release: vi.fn(async () => undefined),
      }),
    );

    const issued = await Promise.all([
      issuer.issue(payloadFor(1, "gpt-5.6-luna")),
      issuer.issue(payloadFor(2, "gpt-5.6-luna")),
      issuer.issue(payloadFor(3, "gpt-5.6-luna")),
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
    expect(repository.issueSnapshotCheckout).toHaveBeenCalledTimes(3);
    expect(repository.reserveIssuance).not.toHaveBeenCalled();
    expect(repository.freezeIssuanceDomain).not.toHaveBeenCalled();
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
    const capture = vi.fn(async () => snapshot);
    let finishLookup!: (value: null) => void;
    repository.getByRunAttemptId.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishLookup = resolve;
        }),
    );
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture },
      repository,
      ({ workspaceScope, executionDomain }) => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess_secure001",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
            ...(executionDomain
              ? { executionDomainDigest: await digestFor(executionDomain) }
              : {}),
          },
        })),
        recoverAfterSandboxLoss: vi.fn(async () => {
          throw new Error("not expected");
        }),
        release,
        workspaceScope,
      }),
    );

    const admitted = payload();
    const callerPayload = {
      ...admitted,
      identity: { ...admitted.identity! },
      input: {
        ...admitted.input,
        repositoryContext: { ...admitted.input.repositoryContext! },
      },
    };
    const options = { ...issueOptions(admitted), failureCleanup: vi.fn() };
    const originalBeforeAcquire = options.beforeSessionAcquire;
    const replacedBeforeAcquire = vi.fn(async () => {
      throw new Error("mutated callback must not run");
    });
    const pending = issuer.issueAdmitted(callerPayload, options);
    callerPayload.identity.turnId = "trn_mutated1";
    callerPayload.identity.runAttemptId = "attempt_mutated1";
    callerPayload.input.repositoryContext.owner = "foreign-owner";
    callerPayload.runId = "run_mutated1";
    callerPayload.sessionId = "foreign-session";
    options.beforeSessionAcquire = replacedBeforeAcquire;
    options.failureCleanup = vi.fn();
    finishLookup(null);
    const issued = await pending;
    expect(replacedBeforeAcquire).not.toHaveBeenCalled();
    expect(options.beforeSessionAcquire).not.toBe(originalBeforeAcquire);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({ owner: "acme" }),
      }),
    );
    expect(issued.checkout.turnId).toBe(admitted.identity!.turnId);
    expect(issued.checkout.runAttemptId).toBe(admitted.identity!.runAttemptId);
    expect(issued.workspaceScope.runId).toBe(admitted.runId);

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
    expect(repository.completeIssuance).toHaveBeenCalledWith(
      issued.checkout,
      expect.any(String),
    );
    expect(
      repository.freezeIssuanceDomain.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.completeIssuance.mock.invocationCallOrder[0]!);
    expect(release).not.toHaveBeenCalled();
    capture.mockResolvedValueOnce(
      WorkspaceSnapshotSchema.parse({ ...snapshot, workspaceId: "wrk_foreign1" }),
    );
    await expect(
      issuer.issueAdmitted(payload(), issueOptions(payload())),
    ).rejects.toMatchObject({ code: "TASK_CHECKOUT_SCOPE_MISMATCH" });
    expect(repository.reserveIssuance).toHaveBeenCalledOnce();
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
            executionDomainDigest: await digestFor(input.executionDomain!),
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
    const first = await issuer.issueAdmitted(payload(), issueOptions(payload()));
    repository.getByRunAttemptId.mockResolvedValueOnce(first.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);

    const resumed = await issuer.issueAdmitted(payload(), issueOptions(payload()));

    expect(resumed.checkout).toEqual(first.checkout);
    expect(capture).toHaveBeenCalledOnce();
    expect(repository.completeIssuance).toHaveBeenCalledOnce();
    expect(sessionFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        persistedReference: {
          secureSessionId: first.checkout.secureSessionId,
          leaseId: first.checkout.leaseId,
          sandboxId: first.checkout.sandboxId,
          generation: first.checkout.generation,
          executionDomainDigest: await digestFor(domainFor(payload())),
        },
      }),
    );
    repository.getByRunAttemptId.mockResolvedValueOnce(first.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);
    repository.getCheckoutExecutionDomainState.mockRejectedValueOnce(
      new Error("custody unavailable"),
    );
    await expect(
      issuer.issueAdmitted(payload(), issueOptions(payload())),
    ).rejects.toThrow("custody unavailable");
    expect(sessionFactory).toHaveBeenCalledTimes(2);
    expect(repository.replaceLease).not.toHaveBeenCalled();
  });

  it("atomically adopts one secure replacement generation without changing checkout provenance", async () => {
    const repository = createRepository();
    const digest = await digestFor(domainFor(payload()));
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
          executionDomainDigest: digest,
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
          executionDomainDigest: digest,
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
    const first = await issuer.issueAdmitted(payload(), issueOptions(payload()));
    repository.getByRunAttemptId.mockResolvedValueOnce(first.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);
    await expect(
      issuer.issueAdmitted(payload(), issueOptions(payload())),
    ).rejects.toMatchObject({
      code: "TASK_CHECKOUT_RESUME_UNAVAILABLE",
      retryable: false,
    });
    expect(repository.replaceLease).not.toHaveBeenCalled();
    expect(first.checkout.generation).toBe(0);

    // The existing Native producer cannot adopt a marked checkout.
    repository.getByRunAttemptId.mockResolvedValueOnce(first.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);
    await expect(issuer.issue(payload())).rejects.toMatchObject({
      code: "TASK_CHECKOUT_DOMAIN_MODE_MISMATCH",
    });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(repository.replaceLease).not.toHaveBeenCalled();

    const legacyPayload = payload();
    legacyPayload.identity!.runAttemptId = RunAttemptIdSchema.parse("attempt_legacy1");
    acquire.mockResolvedValueOnce({
      sessionId: "sess_legacy001",
      token: "legacy-initial-token",
      expiresAt: Date.now() + 60_000,
      lease: {
        leaseId: "lease_legacy01",
        sandboxId: "sb-legacy01",
        generation: 0,
      },
    });
    const legacyFirst = await issuer.issue(legacyPayload);
    repository.getByRunAttemptId.mockResolvedValueOnce(legacyFirst.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);
    repository.getCheckoutExecutionDomainState.mockResolvedValueOnce({
      kind: "legacy",
    });
    await expect(
      issuer.issueAdmitted(legacyPayload, issueOptions(legacyPayload)),
    ).rejects.toMatchObject({ code: "TASK_CHECKOUT_DOMAIN_MODE_MISMATCH" });
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(repository.reserveIssuance).toHaveBeenCalledOnce();

    repository.getByRunAttemptId.mockResolvedValueOnce(legacyFirst.checkout);
    repository.getBySnapshotId.mockResolvedValueOnce(snapshot);
    repository.getCheckoutExecutionDomainState.mockResolvedValueOnce({
      kind: "legacy",
    });
    acquire.mockResolvedValueOnce({
      sessionId: "sess_legacy001",
      token: "legacy-replacement-token",
      expiresAt: Date.now() + 60_000,
      lease: {
        leaseId: "lease_legacy02",
        sandboxId: "sb-legacy02",
        generation: 1,
      },
    });
    const replacedCheckout = TaskCheckoutSchema.parse({
      ...legacyFirst.checkout,
      leaseId: "lease_legacy02",
      sandboxId: "sb-legacy02",
      generation: 1,
    });
    repository.replaceLease.mockResolvedValueOnce(replacedCheckout);
    const legacy = await issuer.issue(legacyPayload);
    expect(legacy.checkout).toEqual(replacedCheckout);
    expect(repository.replaceLease).toHaveBeenCalledWith({
      checkoutId: legacyFirst.checkout.checkoutId,
      expectedLeaseId: "lease_legacy01",
      expectedGeneration: 0,
      nextLeaseId: "lease_legacy02",
      nextSandboxId: "sb-legacy02",
      nextGeneration: 1,
    });
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
      ({ executionDomain }) => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess_secure001",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
            ...(executionDomain
              ? { executionDomainDigest: await digestFor(executionDomain) }
              : {}),
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
      issuer.issue(payload(), { failureCleanup }),
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
        { failureCleanup },
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
      ambiguous.issue(payload(), {
        failureCleanup,
      }),
    ).rejects.toThrow("acquire response lost");
    expect(failureCleanup).not.toHaveBeenCalled();
  });

  it("surfaces a typed capacity recovery failure when issuance compensation fails", async () => {
    const repository = createRepository();
    repository.completeIssuance.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const issuer = new TaskCheckoutIssuer(
      {} as Env,
      { capture: vi.fn(async () => snapshot) },
      repository,
      ({ executionDomain }) => ({
        acquire: vi.fn(async () => ({
          sessionId: "sess_secure001",
          token: "secret-test-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_secure01",
            sandboxId: "sb-secure01",
            generation: 0,
            ...(executionDomain
              ? { executionDomainDigest: await digestFor(executionDomain) }
              : {}),
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
      issuer.issueAdmitted(payload(), { ...issueOptions(payload()), failureCleanup }),
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

function createRepository() {
  let domain: PersistedTaskCheckoutExecutionDomain;
  const issueSnapshotCheckout = vi.fn(
    async (issuedSnapshot: WorkspaceSnapshot, checkout: TaskCheckout) => ({
      snapshot: issuedSnapshot,
      checkout,
    }),
  );
  return {
    issueSnapshotCheckout,
    reserveIssuance: vi.fn(async () => undefined),
    beginIssuanceCallback: vi.fn(async () => undefined),
    freezeIssuanceDomain: vi.fn(async (_id, _token, value) => {
      domain = value;
    }),
    completeIssuance: vi.fn(
      async (checkout: TaskCheckout, _token: string) => checkout,
    ),
    markIssuanceUnknown: vi.fn(async () => undefined),
    getCheckoutExecutionDomain: vi.fn(async () => domain),
    getCheckoutExecutionDomainState: vi.fn(
      async (): ReturnType<
        TaskCheckoutIssuanceRepository["getCheckoutExecutionDomainState"]
      > => ({ kind: "marked", domain }),
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

function domainFor(
  value: ExecuteRunPayload,
): Awaited<ReturnType<BeforeTaskCheckoutSessionAcquire>> {
  const identity = value.identity!;
  return {
    version: 1,
    domain: "legioncode_native",
    scope: {
      userId: value.userId!,
      brainSessionId: value.sessionId,
      workspaceId: identity.workspaceId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      runId: value.runId,
      runAttemptId: identity.runAttemptId,
    },
  };
}
function issueOptions(value: ExecuteRunPayload) {
  return {
    beforeSessionAcquire: (async () =>
      domainFor(value)) satisfies BeforeTaskCheckoutSessionAcquire,
  };
}

function digestFor(
  value: Awaited<ReturnType<BeforeTaskCheckoutSessionAcquire>>,
): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
