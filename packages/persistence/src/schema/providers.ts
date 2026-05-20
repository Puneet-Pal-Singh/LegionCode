import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { workspaces } from "./workspaces.js";
import {
  buildProviderAuditEventTypeSqlList,
  buildProviderAuditStatusSqlList,
  buildProviderCredentialStatusSqlList,
} from "../providers/types.js";

const PROVIDER_CREDENTIAL_STATUS_SQL_LIST =
  buildProviderCredentialStatusSqlList();
const PROVIDER_AUDIT_EVENT_TYPE_SQL_LIST = buildProviderAuditEventTypeSqlList();
const PROVIDER_AUDIT_STATUS_SQL_LIST = buildProviderAuditStatusSqlList();

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    providerId: text("provider_id").notNull(),
    label: text("label").notNull(),
    keyFingerprint: text("key_fingerprint").notNull(),
    encryptedSecretJson: jsonb("encrypted_secret_json").notNull(),
    keyVersion: text("key_version").notNull(),
    status: text("status").notNull().default("connected"),
    lastValidatedAt: timestamp("last_validated_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("provider_credentials_user_provider_idx")
      .on(table.userId, table.providerId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("provider_credentials_user_status_idx").on(
      table.userId,
      table.status,
    ),
    index("provider_credentials_created_at_idx").on(table.createdAt.desc()),
    check(
      "provider_credentials_status_check",
      sql`${table.status} IN (${PROVIDER_CREDENTIAL_STATUS_SQL_LIST})`,
    ),
  ],
);

export const providerPreferences = pgTable(
  "provider_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    defaultProviderId: text("default_provider_id"),
    defaultCredentialId: uuid("default_credential_id"),
    defaultModelId: text("default_model_id"),
    fallbackMode: text("fallback_mode").notNull().default("strict"),
    fallbackJson: jsonb("fallback_json"),
    visibleModelIdsJson: jsonb("visible_model_ids_json").notNull().default({}),
    credentialLabelsJson: jsonb("credential_labels_json").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.workspaceId],
      name: "provider_preferences_user_workspace_pk",
    }),
  ],
);

export const providerAuditEvents = pgTable(
  "provider_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    providerId: text("provider_id"),
    credentialId: uuid("credential_id"),
    operation: text("operation").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("provider_audit_events_scope_time_idx").on(
      table.userId,
      table.workspaceId,
      table.createdAt.desc(),
    ),
    index("provider_audit_events_type_time_idx").on(
      table.operation,
      table.createdAt.desc(),
    ),
    check(
      "provider_audit_events_type_check",
      sql`${table.operation} IN (${PROVIDER_AUDIT_EVENT_TYPE_SQL_LIST})`,
    ),
    check(
      "provider_audit_events_status_check",
      sql`${table.status} IN (${PROVIDER_AUDIT_STATUS_SQL_LIST})`,
    ),
  ],
);

export const providerAxisQuota = pgTable(
  "provider_axis_quota",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dayKey: text("day_key").notNull(),
    usageCount: integer("usage_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.workspaceId, table.dayKey],
      name: "provider_axis_quota_user_workspace_day_pk",
    }),
    index("provider_axis_quota_updated_at_idx").on(table.updatedAt.desc()),
    check(
      "provider_axis_quota_usage_count_check",
      sql`${table.usageCount} >= 0`,
    ),
  ],
);

export const providerRegistryCache = pgTable("provider_registry_cache", {
  providerId: text("provider_id").primaryKey(),
  displayName: text("display_name").notNull(),
  authModesJson: jsonb("auth_modes_json").notNull(),
  capabilitiesJson: jsonb("capabilities_json").notNull(),
  modelsJson: jsonb("models_json").notNull(),
  sourceVersion: text("source_version").notNull(),
  fetchedAt: timestamp("fetched_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  refreshedAt: timestamp("refreshed_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const providerUserModelCache = pgTable(
  "provider_user_model_cache",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    credentialId: text("credential_id").notNull(),
    modelsJson: jsonb("models_json").notNull(),
    sourceVersion: text("source_version").notNull(),
    fetchedAt: timestamp("fetched_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.providerId, table.credentialId],
      name: "provider_user_model_cache_user_provider_credential_pk",
    }),
    index("provider_user_model_cache_expiry_idx").on(table.expiresAt),
  ],
);
