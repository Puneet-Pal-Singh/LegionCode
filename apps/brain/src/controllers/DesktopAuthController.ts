import { z } from "zod";
import type { Env } from "../types/ai";
import {
  createSessionCookie,
  extractSessionToken,
  getAuthenticatedUserSession,
  hashSessionToken,
} from "../services/AuthService";

const INTENT = "desktop-cloud-session-v1" as const;
const Opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Begin = z
  .object({ codeChallenge: Opaque, intent: z.literal(INTENT) })
  .strict();
const Consent = z
  .object({ challengeId: Opaque, csrfToken: Opaque, intent: z.literal(INTENT) })
  .strict();
const Redeem = z
  .object({ challengeId: Opaque, verifier: Opaque, intent: z.literal(INTENT) })
  .strict();
const MAX_BODY_BYTES = 4096;
class DesktopAuthBoundaryError extends Error {}

/** Application port only. Persistence and atomic session issuance stay in AuthService's repository composition. */
export interface DesktopAuthOperations {
  begin(input: {
    codeChallenge: string;
    origin: string;
  }): Promise<{ challengeId: string; expiresAt: string }>;
  prepareConsent(input: {
    challengeId: string;
    sourceSessionHash: string;
    origin: string;
  }): Promise<{ csrfToken: string } | null>;
  authorize(input: {
    challengeId: string;
    csrfToken: string;
    sourceSessionHash: string;
    origin: string;
  }): Promise<boolean>;
  redeem(input: {
    challengeId: string;
    verifier: string;
    origin: string;
  }): Promise<
    | { status: "pending" }
    | { status: "issued"; sessionToken: string; userId: string }
    | { status: "invalid" }
  >;
}

/** Fixed HTTPS authority; never derive the allowed origin from an incoming Host header. */
export function desktopAuthOrigin(
  env: Pick<Env, "GITHUB_REDIRECT_URI">,
): string {
  const url = new URL(env.GITHUB_REDIRECT_URI);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Desktop auth is unavailable");
  return url.origin;
}

export function createDesktopAuthController(operations: DesktopAuthOperations) {
  return {
    async begin(request: Request, env: Env): Promise<Response> {
      try {
        const origin = assertBoundary(request, env, "POST", "application/json");
        const input = Begin.parse(JSON.parse(await readBody(request)));
        const challenge = await operations.begin({
          codeChallenge: input.codeChallenge,
          origin,
        });
        return json(challenge, 201);
      } catch (error) {
        return failure(
          error instanceof DesktopAuthBoundaryError ||
            error instanceof z.ZodError ||
            error instanceof SyntaxError
            ? 400
            : 503,
        );
      }
    },
    async consent(request: Request, env: Env): Promise<Response> {
      try {
        const origin = assertBoundary(request, env, "GET");
        const url = new URL(request.url);
        if (
          [...url.searchParams.keys()].some((key) => key !== "id") ||
          url.searchParams.getAll("id").length !== 1
        )
          return failure();
        const challengeId = Opaque.parse(url.searchParams.get("id"));
        const browser = await browserIdentity(request, env);
        if (!browser) {
          const login = new URL("/auth/github/login", origin);
          login.searchParams.set("desktop_challenge", challengeId);
          return new Response(null, {
            status: 303,
            headers: { ...privateHeaders(), Location: login.toString() },
          });
        }
        const consent = await operations.prepareConsent({
          challengeId,
          sourceSessionHash: browser.sourceSessionHash,
          origin,
        });
        if (!consent) return failure();
        return html(
          `<h1>Connect LegionCode Desktop</h1><p>Allow Desktop to access your cloud work as <strong>${escapeHtml(browser.login)}</strong>?</p><p>Continue only if you started this request in LegionCode Desktop.</p><form method="post" action="/auth/desktop/authorize"><input type="hidden" name="challengeId" value="${challengeId}"><input type="hidden" name="csrfToken" value="${Opaque.parse(consent.csrfToken)}"><input type="hidden" name="intent" value="${INTENT}"><button type="submit">Allow Desktop access</button></form>`,
        );
      } catch (error) {
        return failure(
          error instanceof DesktopAuthBoundaryError ||
            error instanceof z.ZodError ||
            error instanceof SyntaxError
            ? 400
            : 503,
        );
      }
    },
    async authorize(request: Request, env: Env): Promise<Response> {
      try {
        const origin = assertBoundary(
          request,
          env,
          "POST",
          "application/x-www-form-urlencoded",
          true,
        );
        const fields = new URLSearchParams(await readBody(request));
        if ([...fields.keys()].some((key) => fields.getAll(key).length !== 1))
          return failure();
        const input = Consent.parse(Object.fromEntries(fields));
        const browser = await browserIdentity(request, env);
        if (!browser) return failure();
        const approved = await operations.authorize({
          ...input,
          sourceSessionHash: browser.sourceSessionHash,
          origin,
        });
        if (!approved) return failure();
        return html(
          "<h1>Desktop access approved</h1><p>Return to LegionCode Desktop. You can close this tab.</p>",
        );
      } catch (error) {
        return failure(
          error instanceof DesktopAuthBoundaryError ||
            error instanceof z.ZodError ||
            error instanceof SyntaxError
            ? 400
            : 503,
        );
      }
    },
    async redeem(request: Request, env: Env): Promise<Response> {
      try {
        const origin = assertBoundary(request, env, "POST", "application/json");
        const input = Redeem.parse(JSON.parse(await readBody(request)));
        const result = await operations.redeem({ ...input, origin });
        if (result.status === "pending")
          return json(
            { status: "authorization_pending", retryAfterMs: 2000 },
            202,
          );
        if (result.status !== "issued") return failure();
        // Only the canonical authority can produce this fresh session. Its
        // plaintext token exists only long enough to form an HttpOnly cookie.
        return new Response(
          JSON.stringify({ status: "issued", userId: result.userId }),
          {
            status: 200,
            headers: {
              ...privateHeaders(),
              "Content-Type": "application/json",
              "Set-Cookie": createSessionCookie(result.sessionToken),
            },
          },
        );
      } catch (error) {
        return failure(
          error instanceof DesktopAuthBoundaryError ||
            error instanceof z.ZodError ||
            error instanceof SyntaxError
            ? 400
            : 503,
        );
      }
    },
  };
}

function assertBoundary(
  request: Request,
  env: Env,
  method: string,
  mediaType?: string,
  requireOrigin = false,
): string {
  const origin = desktopAuthOrigin(env);
  const suppliedOrigin = request.headers.get("Origin");
  if (
    new URL(request.url).origin !== origin ||
    request.method !== method ||
    (requireOrigin && suppliedOrigin !== origin) ||
    (suppliedOrigin !== null && suppliedOrigin !== origin)
  )
    throw new DesktopAuthBoundaryError("Rejected auth boundary");
  if (
    mediaType &&
    request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== mediaType
  )
    throw new DesktopAuthBoundaryError("Rejected auth media type");
  return origin;
}

async function browserIdentity(
  request: Request,
  env: Env,
): Promise<{ sourceSessionHash: string; login: string } | null> {
  const token = extractSessionToken(request);
  if (!token) return null;
  const auth = await getAuthenticatedUserSession(request, env);
  if (!auth) return null;
  // This authenticates display only. The repository must resolve this exact
  // hash again under the same transaction that authorizes/redeems the challenge.
  return {
    sourceSessionHash: await hashSessionToken(token),
    login: auth.session.login,
  };
}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new DesktopAuthBoundaryError("Missing auth body");
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new DesktopAuthBoundaryError("Auth body too large");
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function privateHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}
function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...privateHeaders(), "Content-Type": "application/json" },
  });
}
function html(body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>LegionCode Desktop access</title><body>${body}</body></html>`,
    {
      headers: {
        ...privateHeaders(),
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
}
function failure(status = 400): Response {
  return json({ error: "desktop_auth_unavailable" }, status);
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
