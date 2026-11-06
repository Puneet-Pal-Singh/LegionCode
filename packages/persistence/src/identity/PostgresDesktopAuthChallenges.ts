import type { SqlClient, SqlRow } from "../sql.js";
import {
  DESKTOP_AUTH_INTENT,
  DesktopAuthChallengeError,
  validateDesktopAuthCreate,
  validateDesktopAuthConsent,
  validateDesktopAuthRedeem,
  type CreateDesktopAuthChallengeInput,
  type PrepareDesktopAuthConsentInput,
  type AuthorizeDesktopAuthChallengeInput,
  type RedeemDesktopAuthChallengeInput,
  type DesktopAuthConsentRecord,
  type DesktopAuthRedeemedSession,
  type DesktopAuthRedeemResult,
} from "./desktop-auth-types.js";

interface ChallengeRow extends SqlRow {
  authorized_source_session_id: string | null;
  authorized_at: string | Date | null;
  expires_at: string | Date;
}
interface SourceSessionRow extends SqlRow {
  id: string;
  user_id: string;
  session_hash: string;
  expires_at: string | Date;
}
interface NewSessionRow extends SqlRow {
  id: string;
  user_id: string;
  expires_at: string | Date;
}

/** Auth exchange metadata only. The existing auth_sessions table owns sessions. */
export class PostgresDesktopAuthChallenges {
  constructor(private readonly client: SqlClient) {}

  async create(input: CreateDesktopAuthChallengeInput): Promise<void> {
    validateDesktopAuthCreate(input);
    const result = await this.client.query(
      `INSERT INTO desktop_auth_challenges
      (challenge_hash,verifier_challenge,origin,intent,expires_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (challenge_hash) DO NOTHING RETURNING challenge_hash`,
      [
        input.challengeIdHash,
        input.verifierChallenge,
        input.origin,
        input.intent,
        input.expiresAt,
        input.now,
      ],
    );
    if (!result.rows[0])
      throw new DesktopAuthChallengeError(
        "challenge_conflict",
        "Desktop authentication challenge already exists",
      );
  }
  async prepare(input: PrepareDesktopAuthConsentInput): Promise<boolean> {
    validateDesktopAuthConsent(input);
    const result = await this.client.query<{ expires_at: string | Date }>(
      `UPDATE desktop_auth_challenges AS c
      SET consent_session_id=s.id,consent_csrf_hash=$3
      FROM auth_sessions AS s
      WHERE c.challenge_hash=$1 AND s.session_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>$6
        AND c.origin=$4 AND c.intent=$5 AND c.expires_at>$6 AND c.consumed_at IS NULL AND c.authorized_at IS NULL
        AND (c.consent_session_id IS NULL OR c.consent_session_id=s.id)
      RETURNING c.expires_at`,
      [
        input.challengeIdHash,
        input.sourceSessionHash,
        input.csrfHash,
        input.origin,
        input.intent,
        input.now,
      ],
    );
    const row = result.rows[0];
    return row !== undefined;
  }
  async authorize(input: AuthorizeDesktopAuthChallengeInput): Promise<boolean> {
    validateDesktopAuthConsent(input);
    return this.client.transaction(async (tx) => {
      // Match redemption's lock order: challenge first, then its exact source.
      const challenge = await tx.query<{ consent_session_id: string }>(
        `SELECT consent_session_id FROM desktop_auth_challenges
          WHERE challenge_hash=$1 AND consent_csrf_hash=$2 AND origin=$3 AND intent=$4
            AND expires_at>$5 AND consumed_at IS NULL AND authorized_at IS NULL
            AND consent_session_id IS NOT NULL FOR UPDATE`,
        [
          input.challengeIdHash,
          input.csrfHash,
          input.origin,
          input.intent,
          input.now,
        ],
      );
      const prepared = challenge.rows[0];
      if (!prepared) return false;
      const source = await tx.query<{ id: string }>(
        `SELECT id FROM auth_sessions WHERE id=$1 AND session_hash=$2
          AND revoked_at IS NULL AND expires_at>$3 FOR UPDATE`,
        [prepared.consent_session_id, input.sourceSessionHash, input.now],
      );
      const active = source.rows[0];
      if (!active) return false;
      const result = await tx.query(
        `WITH authority AS MATERIALIZED (SELECT clock_timestamp() AS checked_at)
          UPDATE desktop_auth_challenges AS c
          SET authorized_source_session_id=s.id,authorized_at=a.checked_at
          FROM auth_sessions AS s, authority AS a
          WHERE c.challenge_hash=$1 AND s.id=$2 AND s.session_hash=$3
            AND c.consent_session_id=s.id AND c.consent_csrf_hash=$4
            AND c.origin=$5 AND c.intent=$6 AND c.expires_at>a.checked_at
            AND s.revoked_at IS NULL AND s.expires_at>a.checked_at
            AND c.consumed_at IS NULL AND c.authorized_at IS NULL RETURNING c.challenge_hash`,
        [
          input.challengeIdHash,
          active.id,
          input.sourceSessionHash,
          input.csrfHash,
          input.origin,
          input.intent,
        ],
      );
      return result.rows.length === 1;
    });
  }
  async redeem(
    input: RedeemDesktopAuthChallengeInput,
  ): Promise<DesktopAuthRedeemResult> {
    validateDesktopAuthRedeem(input);
    try {
      return await this.client.transaction(async (tx) => {
        const challenge = await tx.query<ChallengeRow>(
          `SELECT authorized_source_session_id,authorized_at,expires_at
          FROM desktop_auth_challenges WHERE challenge_hash=$1 AND verifier_challenge=$2 AND origin=$3 AND intent=$4
            AND expires_at>$5 AND consumed_at IS NULL FOR UPDATE`,
          [
            input.challengeIdHash,
            input.verifierChallenge,
            input.origin,
            input.intent,
            input.now,
          ],
        );
        const approved = challenge.rows[0];
        if (!approved) return { status: "invalid" };
        // A challenge may expire while SELECT FOR UPDATE waits. A new statement
        // checks the database clock after that lock before reporting pending.
        const challengeTime = await tx.query<{ active: boolean }>(
          "SELECT expires_at>clock_timestamp() AS active FROM desktop_auth_challenges WHERE challenge_hash=$1",
          [input.challengeIdHash],
        );
        if (challengeTime.rows[0]?.active !== true)
          return { status: "invalid" };
        if (approved.authorized_at === null) return { status: "pending" };
        if (approved.authorized_source_session_id === null)
          return { status: "invalid" };
        // This exact source-session row stays locked through creation/consume;
        // a concurrent revoke cannot slip between validation and the new session.
        const sourceResult = await tx.query<SourceSessionRow>(
          `SELECT id,user_id,session_hash,expires_at FROM auth_sessions
          WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2 FOR UPDATE`,
          [approved.authorized_source_session_id, input.now],
        );
        const source = sourceResult.rows[0];
        if (!source || source.session_hash === input.sessionHash)
          return { status: "invalid" };
        // Both locks are held. Recheck both expiries against one fresh database
        // timestamp at the actual mint statement, never request/transaction time.
        const created = await tx.query<NewSessionRow>(
          `WITH authority AS MATERIALIZED (SELECT clock_timestamp() AS checked_at)
            INSERT INTO auth_sessions(user_id,session_hash,expires_at,created_at,last_seen_at)
            SELECT s.user_id,$2,LEAST($3::timestamptz,s.expires_at),a.checked_at,a.checked_at
            FROM desktop_auth_challenges AS c,auth_sessions AS s,authority AS a
            WHERE c.challenge_hash=$4 AND s.id=$5 AND s.user_id=$1
              AND c.authorized_source_session_id=s.id AND c.consent_session_id=s.id
              AND c.authorized_at IS NOT NULL AND c.consumed_at IS NULL
              AND c.expires_at>a.checked_at AND s.revoked_at IS NULL AND s.expires_at>a.checked_at
              AND $3::timestamptz>a.checked_at
            RETURNING id,user_id,expires_at`,
          [
            source.user_id,
            input.sessionHash,
            input.sessionExpiresAt,
            input.challengeIdHash,
            source.id,
          ],
        );
        const session = created.rows[0];
        if (!session) return { status: "invalid" };
        // The issuance receipt must identify the exact locked source principal.
        // Fail inside this transaction if storage returns a different principal.
        if (session.user_id !== source.user_id)
          throw new DesktopAuthChallengeError(
            "redeem_outcome_unknown",
            "Desktop authentication session principal did not match",
          );
        const consumed = await tx.query(
          `UPDATE desktop_auth_challenges SET consumed_at=clock_timestamp()
          WHERE challenge_hash=$1 AND consumed_at IS NULL RETURNING challenge_hash`,
          [input.challengeIdHash],
        );
        if (consumed.rows.length !== 1)
          throw new DesktopAuthChallengeError(
            "challenge_conflict",
            "Desktop authentication exchange is no longer available",
          );
        return {
          status: "issued",
          authSessionId: session.id,
          userId: source.user_id,
          expiresAt: iso(session.expires_at),
        };
      });
    } catch (error) {
      if (error instanceof DesktopAuthChallengeError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new DesktopAuthChallengeError(
          "session_hash_conflict",
          "Desktop authentication session could not be created",
        );
      }
      throw new DesktopAuthChallengeError(
        "redeem_outcome_unknown",
        "Desktop authentication exchange outcome is unknown",
      );
    }
  }
}
function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
