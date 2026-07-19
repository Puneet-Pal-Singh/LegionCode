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
  };
}

export interface SecureExecutionSessionPort {
  acquire(): Promise<SecureExecutionSessionHandle>;
  recoverAfterSandboxLoss(): Promise<SecureExecutionSessionHandle>;
  release(): Promise<void>;
}

export interface PersistedSecureExecutionSessionReference {
  readonly secureSessionId: string;
  readonly leaseId: LeaseId;
  readonly sandboxId: string;
  readonly generation: number;
}

/**
 * Owns one secure session and its matching sandbox lease. The handle is
 * reusable by checkout issuance and runtime tools, while release remains
 * idempotent and scoped to this exact session token.
 */
export class SecureExecutionSessionClient implements SecureExecutionSessionPort {
  private sessionPromise: Promise<SecureExecutionSessionHandle> | null = null;
  private releasePromise: Promise<void> | null = null;
  private reference: PersistedSecureExecutionSessionReference | undefined;

  constructor(
    private readonly env: Env,
    private readonly brainSessionId: string,
    private readonly runId: string,
    private readonly workspaceScope: SecureExecutionWorkspaceScope,
    persistedReference?: PersistedSecureExecutionSessionReference,
  ) {
    this.reference = persistedReference;
  }

  async acquire(): Promise<SecureExecutionSessionHandle> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.create();
    }
    try {
      const session = await this.sessionPromise;
      this.reference = toPersistedReference(session);
      return session;
    } catch (error) {
      this.sessionPromise = null;
      throw error;
    }
  }

  async recoverAfterSandboxLoss(): Promise<SecureExecutionSessionHandle> {
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

  private async create(): Promise<SecureExecutionSessionHandle> {
    if (this.reference) {
      return await this.resume(this.reference);
    }
    const internalSecret = this.requireInternalSecret();
    for (
      let attempt = 1;
      attempt <= LOCAL_DEV_SESSION_RETRY_ATTEMPTS;
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
        attempt < LOCAL_DEV_SESSION_RETRY_ATTEMPTS &&
        isLocalDevSessionProxyMiss(message)
      ) {
        console.log(
          formatDiagnosticLogLine("execution/tool", "session-retry", {
            runId: this.runId,
            sessionId: this.brainSessionId,
            attempt,
            maxAttempts: LOCAL_DEV_SESSION_RETRY_ATTEMPTS,
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
