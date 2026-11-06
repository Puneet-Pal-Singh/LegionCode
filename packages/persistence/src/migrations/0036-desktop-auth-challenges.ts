import type { SqlMigration } from "./types.js";
export const desktopAuthChallengesMigration: SqlMigration = {
  id: "0036_desktop_auth_challenges",
  description:
    "Single-use approved Desktop authentication exchanges through existing auth sessions",
  statements: [
    `CREATE TABLE desktop_auth_challenges (
      challenge_hash TEXT PRIMARY KEY CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
      verifier_challenge TEXT NOT NULL CHECK(verifier_challenge ~ '^[A-Za-z0-9_-]{43}$'),
      origin TEXT NOT NULL,
      intent TEXT NOT NULL CHECK(intent='desktop-cloud-session-v1'),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      consent_csrf_hash TEXT CHECK(consent_csrf_hash ~ '^[a-f0-9]{64}$'),
      consent_session_id UUID REFERENCES auth_sessions(id) ON DELETE CASCADE,
      authorized_source_session_id UUID REFERENCES auth_sessions(id) ON DELETE CASCADE,
      authorized_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '10 minutes'),
      CHECK((consent_csrf_hash IS NULL)=(consent_session_id IS NULL)),
      CHECK((authorized_at IS NULL)=(authorized_source_session_id IS NULL)),
      CHECK(authorized_source_session_id IS NULL OR authorized_source_session_id=consent_session_id),
      CHECK(consumed_at IS NULL OR authorized_at IS NOT NULL)
    )`,
    `CREATE INDEX desktop_auth_challenges_expiry_idx ON desktop_auth_challenges(expires_at)`,
  ],
};
