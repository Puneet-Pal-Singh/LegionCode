export const DESKTOP_AUTH_INTENT = "desktop-cloud-session-v1" as const;
export const DESKTOP_AUTH_CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000;

export interface DesktopAuthChallengeScope {
  /** SHA-256 hex of the opaque challenge ID; never the raw challenge ID. */
  challengeIdHash: string;
  origin: string;
  intent: typeof DESKTOP_AUTH_INTENT;
  now: string;
}
export interface CreateDesktopAuthChallengeInput extends DesktopAuthChallengeScope {
  /** Unpadded base64url SHA-256 of the PKCE verifier (S256). */
  verifierChallenge: string;
  expiresAt: string;
}
export interface PrepareDesktopAuthConsentInput extends DesktopAuthChallengeScope {
  /** Hash of the cookie session actually making the browser request. */
  sourceSessionHash: string;
  csrfHash: string;
}
export interface AuthorizeDesktopAuthChallengeInput extends PrepareDesktopAuthConsentInput {}
export interface RedeemDesktopAuthChallengeInput extends DesktopAuthChallengeScope {
  verifierChallenge: string;
  sessionHash: string;
  sessionExpiresAt: string;
}
export interface DesktopAuthConsentRecord {
  origin: string;
  intent: typeof DESKTOP_AUTH_INTENT;
  expiresAt: string;
}
export interface DesktopAuthRedeemedSession {
  authSessionId: string;
  userId: string;
  expiresAt: string;
}
export type DesktopAuthRedeemResult =
  | {status:"pending"}
  | {status:"invalid"}
  | ({status:"issued"} & DesktopAuthRedeemedSession);
export interface DesktopAuthChallengeRepository {
  createDesktopAuthChallenge(
    input: CreateDesktopAuthChallengeInput,
  ): Promise<void>;
  prepareDesktopAuthConsent(
    input: PrepareDesktopAuthConsentInput,
  ): Promise<boolean>;
  authorizeDesktopAuthChallenge(
    input: AuthorizeDesktopAuthChallengeInput,
  ): Promise<boolean>;
  redeemDesktopAuthChallenge(
    input: RedeemDesktopAuthChallengeInput,
  ): Promise<DesktopAuthRedeemResult>;
}
export class DesktopAuthChallengeError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "challenge_conflict"
      | "session_hash_conflict"
      | "redeem_outcome_unknown",
    message: string,
  ) {
    super(message);
    this.name = "DesktopAuthChallengeError";
  }
}

export function validateDesktopAuthScope(
  input: DesktopAuthChallengeScope,
): void {
  requireDigest(input.challengeIdHash);
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw invalid();
  }
  if (
    origin.origin !== input.origin ||
    !["https:", "http:"].includes(origin.protocol) ||
    input.intent !== DESKTOP_AUTH_INTENT
  )
    throw invalid();
  requireTime(input.now);
}
export function validateDesktopAuthCreate(
  input: CreateDesktopAuthChallengeInput,
): void {
  validateDesktopAuthScope(input);
  requireVerifier(input.verifierChallenge);
  const duration = requireTime(input.expiresAt) - requireTime(input.now);
  if (duration <= 0 || duration > DESKTOP_AUTH_CHALLENGE_MAX_AGE_MS)
    throw invalid();
}
export function validateDesktopAuthConsent(
  input: PrepareDesktopAuthConsentInput,
): void {
  validateDesktopAuthScope(input);
  requireDigest(input.sourceSessionHash);
  requireDigest(input.csrfHash);
}
export function validateDesktopAuthRedeem(
  input: RedeemDesktopAuthChallengeInput,
): void {
  validateDesktopAuthScope(input);
  requireVerifier(input.verifierChallenge);
  requireDigest(input.sessionHash);
  if (requireTime(input.sessionExpiresAt) <= requireTime(input.now))
    throw invalid();
}
function requireDigest(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw invalid();
}
function requireVerifier(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw invalid();
}
function requireTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalid();
  return time;
}
function invalid(): DesktopAuthChallengeError {
  return new DesktopAuthChallengeError(
    "invalid_input",
    "Desktop authentication exchange input is invalid",
  );
}
