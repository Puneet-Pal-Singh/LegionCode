import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authSessions } from "./identity.js";
export const desktopAuthChallenges = pgTable(
  "desktop_auth_challenges",
  {
    challengeHash: text("challenge_hash").primaryKey(),
    verifierChallenge: text("verifier_challenge").notNull(),
    origin: text("origin").notNull(),
    intent: text("intent").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    consentCsrfHash: text("consent_csrf_hash"),
    consentSessionId: uuid("consent_session_id").references(
      () => authSessions.id,
      { onDelete: "cascade" },
    ),
    authorizedSourceSessionId: uuid("authorized_source_session_id").references(
      () => authSessions.id,
      { onDelete: "cascade" },
    ),
    authorizedAt: timestamp("authorized_at", {
      withTimezone: true,
      mode: "string",
    }),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("desktop_auth_challenges_expiry_idx").on(table.expiresAt),
    check(
      "desktop_auth_challenge_hash_check",
      sql`${table.challengeHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "desktop_auth_verifier_check",
      sql`${table.verifierChallenge} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      "desktop_auth_intent_check",
      sql`${table.intent}='desktop-cloud-session-v1'`,
    ),
    check(
      "desktop_auth_expiry_check",
      sql`${table.expiresAt}>${table.createdAt} AND ${table.expiresAt}<=${table.createdAt}+INTERVAL '10 minutes'`,
    ),
    check(
      "desktop_auth_csrf_check",
      sql`${table.consentCsrfHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "desktop_auth_consent_pair_check",
      sql`(${table.consentCsrfHash} IS NULL)=(${table.consentSessionId} IS NULL)`,
    ),
    check(
      "desktop_auth_authorization_pair_check",
      sql`(${table.authorizedAt} IS NULL)=(${table.authorizedSourceSessionId} IS NULL)`,
    ),
    check(
      "desktop_auth_source_check",
      sql`${table.authorizedSourceSessionId} IS NULL OR ${table.authorizedSourceSessionId}=${table.consentSessionId}`,
    ),
    check(
      "desktop_auth_consumed_check",
      sql`${table.consumedAt} IS NULL OR ${table.authorizedAt} IS NOT NULL`,
    ),
  ],
);
