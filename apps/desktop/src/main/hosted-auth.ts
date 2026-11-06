import { createHash, randomBytes } from "node:crypto";
import { session, shell } from "electron";
import { z } from "zod";

export const HOSTED_AUTH_SESSION_PARTITION = "legioncode-hosted";
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

  signIn(): Promise<HostedAuthState> {
    if (this.operation) return this.operation;
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
    this.update(uncertain ? "redemption_uncertain" : "cancelled");
  }

  private async authorize(
    generation: number,
    controller: AbortController,
  ): Promise<HostedAuthState> {
    let redemptionSent = false;
    const timeout = setTimeout(() => controller.abort(), MAX_LOGIN_MS);
    // Verifier exists only in this bounded main-process operation. Persist only
    // its S256 challenge on the server; never put it in the browser URL.
    let verifier = randomBytes(32).toString("base64url");
    try {
      this.update("authorizing");
      const startedAt = Date.now();
      const challengeResponse = await this.post(
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
      if (expiresAt <= Date.now() || expiresAt > startedAt + MAX_LOGIN_MS)
        throw new Error("Invalid challenge expiry");
      this.assertCurrent(generation, controller.signal);
      const authorizationUrl = new URL("/auth/desktop/authorize", this.origin);
      authorizationUrl.searchParams.set("id", challenge.challengeId);
      await shell.openExternal(authorizationUrl.toString());
      while (Date.now() < expiresAt) {
        this.assertCurrent(generation, controller.signal);
        redemptionSent = true;
        this.redeemGeneration = generation;
        const response = await this.post(
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
          if (this.redeemGeneration === generation) this.redeemGeneration = null;
          await pause(
            Math.min(pending.retryAfterMs, Math.max(0, expiresAt - Date.now())),
            controller.signal,
          );
          continue;
        }
        if (response.status !== 204) {
          await response.body?.cancel();
          throw new Error("Redemption rejected");
        }
        this.assertCurrent(generation, controller.signal);
        // Electron's isolated session accepts Set-Cookie directly. There is no
        // cookie extraction/copy and no provider credential involved here.
        const verified = await this.getSession(controller.signal);
        if (!verified) throw new Error("Session unavailable");
        this.assertCurrent(generation, controller.signal);
        this.redeemGeneration = null;
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
    path: string,
    body: Record<string, string>,
    signal: AbortSignal,
    credentials: RequestCredentials,
  ): Promise<Response> {
    return session
      .fromPartition(HOSTED_AUTH_SESSION_PARTITION)
      .fetch(`${this.origin}${path}`, {
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

  private async getSession(signal: AbortSignal): Promise<boolean> {
    const response = await session
      .fromPartition(HOSTED_AUTH_SESSION_PARTITION)
      .fetch(`${this.origin}/auth/session`, {
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
      return false;
    }
    return z
      .object({
        authenticated: z.literal(true),
        user: z.object({ id: z.string().min(1) }),
      })
      .safeParse(await readJson(response)).success;
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
