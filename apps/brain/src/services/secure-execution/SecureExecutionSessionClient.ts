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
  release(): Promise<void>;
}

/**
 * Owns one secure session and its matching sandbox lease. The handle is
 * reusable by checkout issuance and runtime tools, while release remains
 * idempotent and scoped to this exact session token.
 */
export class SecureExecutionSessionClient implements SecureExecutionSessionPort {
  private sessionPromise: Promise<SecureExecutionSessionHandle> | null = null;
  private releasePromise: Promise<void> | null = null;

  constructor(
    private readonly env: Env,
    private readonly brainSessionId: string,
    private readonly runId: string,
    private readonly workspaceScope: SecureExecutionWorkspaceScope,
  ) {}

  async acquire(): Promise<SecureExecutionSessionHandle> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.create();
    }
    try {
      return await this.sessionPromise;
    } catch (error) {
      this.sessionPromise = null;
      throw error;
    }
  }

  async release(): Promise<void> {
    if (!this.releasePromise) {
      this.releasePromise = this.releaseNow();
    }
    return await this.releasePromise;
  }

  private async create(): Promise<SecureExecutionSessionHandle> {
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
          headers: { "Content-Type": "application/json" },
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

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
