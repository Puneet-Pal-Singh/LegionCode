import { createHash, randomBytes, randomUUID } from "node:crypto";
import { session, shell, type Session } from "electron";
import { z } from "zod";

export type HostedAuthConnection = {
  readonly session: Session;
  readonly userId: string;
};
// Candidate partitions are private, ephemeral, and never shared with a renderer.
const CANDIDATE_PARTITION_PREFIX = "legioncode-hosted-auth-";
const INTENT = "desktop-cloud-session-v1";
const MAX_RESPONSE_BYTES = 8_192;
const MAX_LOGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const ChallengeSchema = z
  .object({
    challengeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
const IssuedSchema = z
  .object({ status: z.literal("issued"), userId: z.string().min(1) })
  .strict();
const SessionSchema = z.object({
  authenticated: z.literal(true),
  user: z.object({ id: z.string().min(1) }),
});
const PendingSchema = z
  .object({
    status: z.literal("authorization_pending"),
    retryAfterMs: z.number().int().min(1_000).max(10_000),
  })
  .strict();

export type HostedAuthState =
  | "idle"
  | "authorizing"
  | "authenticated"
  | "cancelled"
  | "expired"
  | "unavailable"
  | "redemption_uncertain";

/** Main-only custody. No method returns a verifier, challenge, URL or cookie. */
export class HostedAuth {
  private generation = 0;
  private controller: AbortController | null = null;
  private operation: Promise<HostedAuthState> | null = null;
  private current: HostedAuthState = "idle";
  private authenticatedConnection: HostedAuthConnection | null = null;
  private redeemGeneration: number | null = null;
  private readonly origin: string;

  constructor(
    configuredOrigin: string,
    private readonly onState: (state: HostedAuthState) => void,
  ) {
    const url = new URL(configuredOrigin);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Hosted authentication requires a configured HTTPS origin",
      );
    }
    this.origin = url.origin;
  }

  getState(): HostedAuthState {
    return this.current;
  }

  /** Main-only reference. Never serialize this object over renderer IPC. */
  getAuthenticatedConnection(): HostedAuthConnection | null {
    return this.current === "authenticated"
      ? this.authenticatedConnection
      : null;
  }

  signIn(): Promise<HostedAuthState> {
    if (this.operation) return this.operation;
    this.authenticatedConnection = null;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const operation = this.authorize(generation, controller);
    this.operation = operation;
    const finish = () => {
      if (this.operation === operation) this.operation = null;
      if (this.controller === controller) this.controller = null;
    };
    void operation.then(finish, finish);
    return operation;
  }

  cancel(): void {
    const uncertain = this.redeemGeneration === this.generation;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.operation = null;
    this.authenticatedConnection = null;
    this.update(uncertain ? "redemption_uncertain" : "cancelled");
  }

  private async authorize(
    generation: number,
    controller: AbortController,
  ): Promise<HostedAuthState> {
    let redemptionSent = false;
    // The session belongs to this operation, not mutable current selection. An
    // old response can affect only this candidate, which remains unpublished
    // after cancellation or an uncertain outcome.
    const candidate = session.fromPartition(
      `${CANDIDATE_PARTITION_PREFIX}${randomUUID()}`,
    );
    const timeout = setTimeout(() => controller.abort(), MAX_LOGIN_MS);
    // Verifier exists only in this bounded main-process operation. Persist only
    // its S256 challenge on the server; never put it in the browser URL.
    let verifier = randomBytes(32).toString("base64url");
    try {
      this.update("authorizing");
      const startedAt = Date.now();
      const challengeResponse = await this.post(
        candidate,
        "/auth/desktop/challenges",
        {
          codeChallenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          intent: INTENT,
        },
        controller.signal,
        "omit",
      );
      if (challengeResponse.status !== 201)
        throw new Error("Challenge unavailable");
      const challenge = ChallengeSchema.parse(
        await readJson(challengeResponse),
      );
      const expiresAt = Date.parse(challenge.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new Error("Invalid challenge expiry");
      // Server expiry starts when Brain receives the request. Positive network
      // latency must not invalidate it; the independent local timer still caps
      // this operation even if the server clock or expiry is further ahead.
      const deadline = Math.min(expiresAt, startedAt + MAX_LOGIN_MS);
      this.assertCurrent(generation, controller.signal);
      const authorizationUrl = new URL("/auth/desktop/authorize", this.origin);
      authorizationUrl.searchParams.set("id", challenge.challengeId);
      await shell.openExternal(authorizationUrl.toString());
      while (Date.now() < deadline) {
        this.assertCurrent(generation, controller.signal);
        redemptionSent = true;
        this.redeemGeneration = generation;
        const response = await this.post(
          candidate,
          "/auth/desktop/redeem",
          {
            challengeId: challenge.challengeId,
            verifier,
            intent: INTENT,
          },
          controller.signal,
          "include",
        );
        if (response.status === 202) {
          const pending = PendingSchema.parse(await readJson(response));
          // Only an explicit pending receipt proves no session was minted and
          // permits another poll. Any ambiguous delivery ends this operation.
          redemptionSent = false;
          if (this.redeemGeneration === generation)
            this.redeemGeneration = null;
          await pause(
            Math.min(pending.retryAfterMs, Math.max(0, deadline - Date.now())),
            controller.signal,
          );
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error("Redemption rejected");
        }
        const issued = IssuedSchema.parse(await readJson(response));
        this.assertCurrent(generation, controller.signal);
        // Verify the issued identity against this fresh candidate's cookie jar;
        // an existing Desktop/browser account cannot satisfy this correlation.
        const verifiedUserId = await this.getSession(
          candidate,
          controller.signal,
        );
        if (verifiedUserId !== issued.userId)
          throw new Error("Session identity mismatch");
        this.assertCurrent(generation, controller.signal);
        this.redeemGeneration = null;
        this.authenticatedConnection = Object.freeze({
          session: candidate,
          userId: issued.userId,
        });
        this.update("authenticated");
        return this.current;
      }
      this.update("expired");
    } catch {
      if (generation !== this.generation) return this.current;
      this.update(
        redemptionSent
          ? "redemption_uncertain"
          : controller.signal.aborted
            ? "expired"
            : "unavailable",
      );
    } finally {
      clearTimeout(timeout);
      verifier = "";
    }
    return this.current;
  }

  private async post(
    candidate: Session,
    path: string,
    body: Record<string, string>,
    signal: AbortSignal,
    credentials: RequestCredentials,
  ): Promise<Response> {
    return candidate.fetch(`${this.origin}${path}`, {
      method: "POST",
      redirect: "error",
      credentials,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
  }

  private async getSession(
    candidate: Session,
    signal: AbortSignal,
  ): Promise<string | null> {
    const response = await candidate.fetch(`${this.origin}/auth/session`, {
      method: "GET",
      credentials: "include",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const verified = SessionSchema.safeParse(await readJson(response));
    return verified.success ? verified.data.user.id : null;
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (generation !== this.generation || signal.aborted)
      throw new Error("Authentication cancelled");
  }

  private update(state: HostedAuthState): void {
    this.current = state;
    this.onState(state);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing authentication response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Authentication response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = Buffer.concat(chunks);
  return JSON.parse(combined.toString("utf8")) as unknown;
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Authentication cancelled");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Authentication cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
