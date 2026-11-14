import {
  LeaseIdSchema,
  TaskCheckoutIdSchema,
  type LeaseId,
  type TaskCheckoutId,
} from "@repo/platform-protocol";
import { z } from "zod";
import type { SecureExecutionWorkspaceScope } from "../../runtime/RuntimeWorkspaceScope";
import type { Env } from "../../types/ai";
import {
  sanitizeLogText,
  sanitizeUnknownError,
} from "../../core/security/LogSanitizer";
import { formatDiagnosticLogLine } from "../../lib/diagnostic-log";
import { parseNativeCommandClosure, type NativeCommandClosure } from "@repo/shared-types/native-command-closure";
import { executionDomainDigest, snapshotExecutionDomain, type ServerExecutionDomainBinding } from "@repo/worker-protocol/private/execution-domain";

const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;
const LOCAL_DEV_SESSION_RETRY_ATTEMPTS = 10;
const LOCAL_DEV_SESSION_RETRY_DELAY_MS = 500;
const EXECUTION_SESSION_REPO_PATH = ".";

const SecureExecutionSessionResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    token: z.string().min(1),
    expiresAt: z.number().int().positive(),
    lease: z
      .object({
        leaseId: LeaseIdSchema,
        sandboxId: z.string().min(1),
        generation: z.number().int().nonnegative(),
        executionDomainDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const SecureExecutionSessionErrorResponseSchema = z
  .object({
    code: z.string().min(1),
    error: z.string().min(1),
  })
  .passthrough();

export class SecureExecutionSessionRecoveryError extends Error {
  readonly code = "SANDBOX_RECOVERY_EXHAUSTED" as const;
  readonly retryable = false as const;

  constructor() {
    super("The task sandbox replacement budget is exhausted.");
    this.name = "SecureExecutionSessionRecoveryError";
  }
}

export interface SecureExecutionSessionHandle {
  readonly sessionId: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly lease: {
    readonly leaseId: LeaseId;
    readonly sandboxId: string;
    readonly generation: number;
    readonly executionDomainDigest?: string;
  };
}

export interface SecureExecutionSessionPort {
  acquire(): Promise<SecureExecutionSessionHandle>;
  recoverAfterSandboxLoss(): Promise<SecureExecutionSessionHandle>;
  cancelTask(taskId: string): Promise<boolean>;
  cancelTaskWithNativeClosure?(taskId: string): Promise<{ cancelled: boolean; nativeCommandClosure: NativeCommandClosure | null }>;
  parseNativeClosure?(value: unknown, taskId: string): Promise<NativeCommandClosure | null>;
  release(): Promise<void>;
}

export interface PersistedSecureExecutionSessionReference {
  readonly secureSessionId: string;
  readonly leaseId: LeaseId;
  readonly sandboxId: string;
  readonly generation: number;
  readonly executionDomainDigest?: string;
}

/**
 * Owns one secure session and its matching sandbox lease. The handle is
 * reusable by checkout issuance and runtime tools, while release remains
 * idempotent and scoped to this exact session token.
 */
export class SecureExecutionSessionClient implements SecureExecutionSessionPort {
  private sessionPromise: Promise<SecureExecutionSessionHandle> | null = null;
  private originalPromise: Promise<SecureExecutionSessionHandle> | null = null;
  private releasePromise: Promise<void> | null = null;
  private reference: PersistedSecureExecutionSessionReference | undefined;
  private readonly executionDomain: ServerExecutionDomainBinding | undefined;

  constructor(
    private readonly env: Env,
    private readonly brainSessionId: string,
    private readonly runId: string,
    private readonly workspaceScope: SecureExecutionWorkspaceScope,
    persistedReference?: PersistedSecureExecutionSessionReference,
    executionDomain?: ServerExecutionDomainBinding,
  ) {
    this.reference = persistedReference ? Object.freeze({ ...persistedReference }) : undefined;
    this.workspaceScope = Object.freeze({ ...workspaceScope });
    this.executionDomain = executionDomain ? snapshotExecutionDomain(executionDomain) : undefined;
    if (this.executionDomain && this.reference && !this.reference.executionDomainDigest) {
      throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
    }
    const scope = this.executionDomain?.scope;
    if (scope && (scope.brainSessionId !== brainSessionId || scope.runId !== runId || scope.workspaceId !== workspaceScope.workspaceId ||
      scope.threadId !== workspaceScope.threadId || scope.turnId !== workspaceScope.turnId || scope.runAttemptId !== workspaceScope.runAttemptId)) {
      throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
    }
  }

  async acquire(): Promise<SecureExecutionSessionHandle> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.create();
    }
    try {
      const session = await this.sessionPromise;
      await this.validateDomainHandle(session);
      this.reference = toPersistedReference(session);
      return session;
    } catch (error) {
      // A bound or explicitly borrowed original cannot be recreated after an
      // observer failure. Its original rejected operation remains retained.
      if (!this.executionDomain && !this.originalPromise) this.sessionPromise = null;
      throw error;
    }
  }

  async borrowOriginal(): Promise<SecureExecutionSessionHandle> {
    if (!this.originalPromise) this.originalPromise = this.readOriginal();
    // Seed before awaiting so tools/cancel cannot enter replacement-capable
    // acquisition while the exact original borrow is still in flight.
    if (!this.sessionPromise) this.sessionPromise = this.originalPromise;
    const handle = await this.originalPromise;
    this.reference = toPersistedReference(handle);
    return handle;
  }

  private async readOriginal(): Promise<SecureExecutionSessionHandle> {
    const reference = this.reference;
    if (!reference) {
      throw new Error("Git borrowing requires the persisted checkout lease identity");
    }
    const response = await fetchWithTimeout(
      this.env.SECURE_API,
      `http://internal/api/v1/session/${encodeURIComponent(reference.secureSessionId)}/borrow?session=${encodeURIComponent(this.brainSessionId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Runtime-Secret": this.requireInternalSecret(),
        },
        body: JSON.stringify({
          runId: this.runId,
          workspaceScope: this.workspaceScope,
          ...(this.executionDomain ? { executionDomain: this.executionDomain } : {}),
          lease: {
            leaseId: reference.leaseId,
            sandboxId: reference.sandboxId,
            generation: reference.generation,
          },
        }),
      },
      DEFAULT_EXECUTION_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error("The original secure checkout session is unavailable for Git borrowing");
    }
    const handle = SecureExecutionSessionResponseSchema.parse(
      await parseJsonResponse(response),
    );
    await this.validateDomainHandle(handle);
    const exactLease = handle.sessionId === reference.secureSessionId &&
      handle.lease.leaseId === reference.leaseId &&
      handle.lease.sandboxId === reference.sandboxId &&
      handle.lease.generation === reference.generation;
    const leaseExpiry = (handle.lease as { expiresAt?: unknown }).expiresAt;
    if (!exactLease || typeof leaseExpiry !== "number" || leaseExpiry <= Date.now()) {
      throw new Error("The original secure checkout lease is unavailable for Git borrowing");
    }
    return handle;
  }

  async recoverAfterSandboxLoss(): Promise<SecureExecutionSessionHandle> {
    if (this.executionDomain || this.originalPromise) {
      throw new Error("SECURE_ORIGINAL_SESSION_RECOVERY_REQUIRED");
    }
    const reference = this.reference;
    if (!reference) {
      await this.acquire();
    }
    const recoverableReference = this.reference;
    if (!recoverableReference) {
      throw new Error(
        "Secure execution session cannot recover without persisted lease identity",
      );
    }
    const recovered = await this.resume(recoverableReference);
    await this.validateDomainHandle(recovered);
    this.reference = toPersistedReference(recovered);
    this.sessionPromise = Promise.resolve(recovered);
    this.releasePromise = null;
    return recovered;
  }

  async release(): Promise<void> {
    if (!this.releasePromise) {
      this.releasePromise = this.releaseNow();
    }
    return await this.releasePromise;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    return (await this.cancelTaskRequest(taskId, "observed")).cancelled;
  }

  async cancelTaskWithNativeClosure(taskId: string): Promise<{ cancelled: boolean; nativeCommandClosure: NativeCommandClosure | null }> {
    return await this.cancelTaskRequest(taskId, "retained");
  }

  private async cancelTaskRequest(taskId: string, lifetime: "observed" | "retained"): Promise<{ cancelled: boolean; nativeCommandClosure: NativeCommandClosure | null }> {
    const session = await this.acquire();
    const url = `http://internal/api/v1/cancel?session=${encodeURIComponent(this.brainSessionId)}`;
    const init = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: session.sessionId, taskId }),
    };
    const response = lifetime === "retained" ? await this.env.SECURE_API.fetch(url, init)
      : await fetchWithTimeout(this.env.SECURE_API, url, init, DEFAULT_EXECUTION_TIMEOUT_MS);
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      const error = SecureExecutionSessionErrorResponseSchema.safeParse(body);
      throw new Error(
        sanitizeLogText(
          error.success ? error.data.error : "Failed to cancel secure task",
        ),
      );
    }
    const parsed = z.object({ cancelled: z.boolean(), nativeCommandClosure: z.unknown().optional() }).parse(body);
    return { cancelled: parsed.cancelled, nativeCommandClosure: await this.parseNativeClosure(parsed.nativeCommandClosure, taskId) };
  }

  /** Private evidence is checked against the originally acquired authenticated
   * session. Reading a response never provisions or recovers a replacement. */
  async parseNativeClosure(value: unknown, taskId: string): Promise<NativeCommandClosure | null> {
    if (this.executionDomain?.domain !== "legioncode_native") return null;
    const pending = this.sessionPromise;
    if (!pending) return null;
    const session = await pending;
    const reference = this.reference;
    if (!reference || reference.secureSessionId !== session.sessionId || reference.leaseId !== session.lease.leaseId ||
      reference.sandboxId !== session.lease.sandboxId || reference.generation !== session.lease.generation) return null;
    return parseNativeCommandClosure(value, {
      executionDomainDigest: await executionDomainDigest(this.executionDomain),
      sessionId: session.sessionId, leaseId: session.lease.leaseId, sandboxId: session.lease.sandboxId,
      generation: session.lease.generation, taskId, workspaceId: this.workspaceScope.workspaceId,
      workspaceRoot: this.workspaceScope.root, runId: this.runId, threadId: this.workspaceScope.threadId,
      turnId: this.workspaceScope.turnId, runAttemptId: this.workspaceScope.runAttemptId,
    });
  }

  private async validateDomainHandle(session: SecureExecutionSessionHandle): Promise<void> {
    const expected = this.executionDomain ? await executionDomainDigest(this.executionDomain) : undefined;
    if (session.lease.executionDomainDigest !== expected ||
      (this.reference?.executionDomainDigest !== undefined && this.reference.executionDomainDigest !== expected)) {
      throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
    }
  }

  private async create(): Promise<SecureExecutionSessionHandle> {
    if (this.reference) {
      return this.executionDomain ? await this.borrowOriginal() : await this.resume(this.reference);
    }
    const internalSecret = this.requireInternalSecret();
    const maximumAttempts = this.executionDomain ? 1 : LOCAL_DEV_SESSION_RETRY_ATTEMPTS;
    for (
      let attempt = 1;
      attempt <= maximumAttempts;
      attempt += 1
    ) {
      const response = await fetchWithTimeout(
        this.env.SECURE_API,
        `http://internal/api/v1/session?session=${encodeURIComponent(this.brainSessionId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Runtime-Secret": internalSecret,
          },
          body: JSON.stringify({
            runId: this.runId,
            taskId: `brain-session-${this.brainSessionId}`,
            repoPath: EXECUTION_SESSION_REPO_PATH,
            workspaceScope: this.workspaceScope,
            ...(this.executionDomain ? { executionDomain: this.executionDomain } : {}),
          }),
        },
        DEFAULT_EXECUTION_TIMEOUT_MS,
      );

      if (response.ok) {
        const body = await parseJsonResponse(response);
        return SecureExecutionSessionResponseSchema.parse(body);
      }

      const message =
        (await response.text()) || "Failed to create secure execution session";
      if (
        attempt < maximumAttempts &&
        isLocalDevSessionProxyMiss(message)
      ) {
        console.log(
          formatDiagnosticLogLine("execution/tool", "session-retry", {
            runId: this.runId,
            sessionId: this.brainSessionId,
            attempt,
            maxAttempts: maximumAttempts,
          }),
        );
        await sleep(LOCAL_DEV_SESSION_RETRY_DELAY_MS);
        continue;
      }
      throw new Error(sanitizeLogText(message));
    }
    throw new Error("Failed to create secure execution session");
  }

  private async resume(
    reference: PersistedSecureExecutionSessionReference,
  ): Promise<SecureExecutionSessionHandle> {
    const response = await fetchWithTimeout(
      this.env.SECURE_API,
      `http://internal/api/v1/session/${encodeURIComponent(reference.secureSessionId)}/resume?session=${encodeURIComponent(this.brainSessionId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Runtime-Secret": this.requireInternalSecret(),
        },
        body: JSON.stringify({
          workspaceScope: this.workspaceScope,
          ...(this.executionDomain ? { executionDomain: this.executionDomain } : {}),
          lease: {
            leaseId: reference.leaseId,
            sandboxId: reference.sandboxId,
            generation: reference.generation,
          },
        }),
      },
      DEFAULT_EXECUTION_TIMEOUT_MS,
    );
    if (!response.ok) {
      const responseText = await response.text();
      const errorBody =
        SecureExecutionSessionErrorResponseSchema.safeParse(
          parseJsonText(responseText),
        );
      if (
        errorBody.success &&
        errorBody.data.code === "SANDBOX_RECOVERY_EXHAUSTED"
      ) {
        throw new SecureExecutionSessionRecoveryError();
      }
      const detail = sanitizeLogText(
        responseText || "Failed to resume secure execution session",
      );
      throw new Error(
        `Secure execution session resume failed with HTTP ${response.status}: ${detail}`,
      );
    }
    const handle = SecureExecutionSessionResponseSchema.parse(
      await parseJsonResponse(response),
    );
    const exactLease =
      handle.lease.leaseId === reference.leaseId &&
      handle.lease.sandboxId === reference.sandboxId &&
      handle.lease.generation === reference.generation;
    const replacementLease =
      handle.lease.generation === reference.generation + 1 &&
      handle.lease.leaseId !== reference.leaseId &&
      handle.lease.sandboxId !== reference.sandboxId;
    if (
      handle.sessionId !== reference.secureSessionId ||
      (!exactLease && !replacementLease)
    ) {
      throw new Error(
        "Secure execution session resume returned mismatched checkout identity",
      );
    }
    return handle;
  }

  private requireInternalSecret(): string {
    const secret = this.env.INTERNAL_RUNTIME_EVENT_SECRET?.trim();
    if (!secret) {
      throw new Error(
        "Internal runtime authentication is required for secure execution sessions",
      );
    }
    return secret;
  }

  private async releaseNow(): Promise<void> {
    const sessionPromise = this.sessionPromise;
    if (!sessionPromise) return;

    let session: SecureExecutionSessionHandle;
    try {
      session = await sessionPromise;
    } catch (error) {
      console.error(
        formatDiagnosticLogLine("execution/lease", "release-skipped", {
          runId: this.runId,
          sessionId: this.brainSessionId,
          reason: "session-creation-failed",
          error: sanitizeUnknownError(error),
        }),
      );
      return;
    }

    const response = await fetchWithTimeout(
      this.env.SECURE_API,
      `http://internal/api/v1/session/${encodeURIComponent(session.sessionId)}?session=${encodeURIComponent(this.brainSessionId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` },
      },
      DEFAULT_EXECUTION_TIMEOUT_MS,
    );
    if (response.status === 404) {
      console.warn(
        formatDiagnosticLogLine("execution/lease", "release-missing", {
          runId: this.runId,
          sessionId: this.brainSessionId,
          secureSessionId: session.sessionId,
          leaseId: session.lease.leaseId,
          httpStatus: response.status,
        }),
      );
      return;
    }
    if (!response.ok) {
      const detail = sanitizeLogText((await response.text()) || "unknown");
      throw new Error(
        `Secure execution lease release failed with HTTP ${response.status}: ${detail}`,
      );
    }
    console.log(
      formatDiagnosticLogLine("execution/lease", "released", {
        runId: this.runId,
        sessionId: this.brainSessionId,
        secureSessionId: session.sessionId,
        leaseId: session.lease.leaseId,
        httpStatus: response.status,
      }),
    );
  }
}

function toPersistedReference(
  session: SecureExecutionSessionHandle,
): PersistedSecureExecutionSessionReference {
  return {
    secureSessionId: session.sessionId,
    leaseId: session.lease.leaseId,
    sandboxId: session.lease.sandboxId,
    generation: session.lease.generation,
    ...(session.lease.executionDomainDigest ? { executionDomainDigest: session.lease.executionDomainDigest } : {}),
  };
}

export function canonicalTaskCheckoutRoot(checkoutId: TaskCheckoutId): string {
  return `/home/sandbox/checkouts/${TaskCheckoutIdSchema.parse(checkoutId)}`;
}

async function parseJsonResponse(
  response: Awaited<ReturnType<Env["SECURE_API"]["fetch"]>>,
): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Expected JSON response from secure execution API: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function fetchWithTimeout(
  service: Env["SECURE_API"],
  input: string,
  init: Parameters<Env["SECURE_API"]["fetch"]>[1],
  timeoutMs: number,
): Promise<Awaited<ReturnType<Env["SECURE_API"]["fetch"]>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Execution request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([service.fetch(input, init), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isLocalDevSessionProxyMiss(message: string): boolean {
  return (
    /No matching request handler|Couldn't find a destination service/u.test(
      message,
    ) ||
    /couldn't find a local dev session/iu.test(message) ||
    /entrypoint of service .* to proxy to/iu.test(message)
  );
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
