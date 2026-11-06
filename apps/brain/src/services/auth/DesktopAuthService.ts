import type { DesktopAuthOperations } from "../../controllers/DesktopAuthController";
import type { Env } from "../../types/ai";
import {
  AUTH_SESSION_TTL_SECONDS,
  generateOpaqueSessionToken,
  hashSessionToken,
  withIdentitySessionRepository,
} from "../AuthService";

const INTENT = "desktop-cloud-session-v1" as const;
const CHALLENGE_TTL_MS = 5 * 60_000;

/** Stateless auth application adapter. The identity repository owns all durable state and atomic issuance. */
export function composeDesktopAuthOperations(env: Env): DesktopAuthOperations {
  return {
    async begin({ codeChallenge, origin }) {
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + CHALLENGE_TTL_MS,
      ).toISOString();
      const challengeId = randomOpaque();
      const challengeIdHash = await hashSessionToken(challengeId);
      await withIdentitySessionRepository(env, (repository) =>
        repository.createDesktopAuthChallenge({
          challengeIdHash,
          verifierChallenge: codeChallenge,
          origin,
          intent: INTENT,
          expiresAt,
          now: now.toISOString(),
        }),
      );
      return { challengeId, expiresAt };
    },
    async prepareConsent({ challengeId, sourceSessionHash, origin }) {
      const csrfToken = randomOpaque();
      const challengeIdHash = await hashSessionToken(challengeId);
      const csrfHash = await hashSessionToken(csrfToken);
      const accepted = await withIdentitySessionRepository(env, (repository) =>
        repository.prepareDesktopAuthConsent({
          challengeIdHash,
          sourceSessionHash,
          csrfHash,
          origin,
          intent: INTENT,
          now: new Date().toISOString(),
        }),
      );
      return accepted ? { csrfToken } : null;
    },
    async authorize({ challengeId, csrfToken, sourceSessionHash, origin }) {
      const challengeIdHash = await hashSessionToken(challengeId);
      const csrfHash = await hashSessionToken(csrfToken);
      return withIdentitySessionRepository(env, (repository) =>
        repository.authorizeDesktopAuthChallenge({
          challengeIdHash,
          csrfHash,
          sourceSessionHash,
          origin,
          intent: INTENT,
          now: new Date().toISOString(),
        }),
      );
    },
    async redeem({ challengeId, verifier, origin }) {
      const now = new Date();
      const sessionToken = generateOpaqueSessionToken();
      const sessionHash = await hashSessionToken(sessionToken);
      const challengeIdHash = await hashSessionToken(challengeId);
      const verifierChallenge = encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        ),
      );
      const result = await withIdentitySessionRepository(env, (repository) =>
        repository.redeemDesktopAuthChallenge({
          challengeIdHash,
          verifierChallenge,
          origin,
          intent: INTENT,
          sessionHash,
          // Repository additionally caps this to the authorized source session's
          // expiry and rechecks revocation under its atomic mint transaction.
          sessionExpiresAt: new Date(
            now.getTime() + AUTH_SESSION_TTL_SECONDS * 1000,
          ).toISOString(),
          now: now.toISOString(),
        }),
      );
      return result.status === "issued"
        ? { status: "issued", sessionToken }
        : result;
    },
  };
}

function randomOpaque(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
