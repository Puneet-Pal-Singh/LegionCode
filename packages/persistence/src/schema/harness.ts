import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
  timestamp,
  foreignKey,
} from "drizzle-orm/pg-core";

export const harnessBindings = pgTable(
  "harness_bindings",
  {
    turnId: text("turn_id").primaryKey(),
    runAttemptId: text("run_attempt_id").notNull().unique(),
    userId: text("user_id").notNull(),
    selectionJson: jsonb("selection_json").notNull(),
    selectionFingerprint: text("selection_fingerprint").notNull(),
    attachmentJson: jsonb("attachment_json"),
    externalTurnId: text("external_turn_id"),
    lastObservationSequence: bigint("last_observation_sequence", {
      mode: "number",
    })
      .notNull()
      .default(0),
  },
  (table) => [
    check(
      "harness_bindings_sequence_check",
      sql`${table.lastObservationSequence} >= 0`,
    ),
  ],
);
export const harnessObservationReceipts = pgTable(
  "harness_observation_receipts",
  {
    turnId: text("turn_id")
      .notNull()
      .references(() => harnessBindings.turnId, { onDelete: "cascade" }),
    processGeneration: text("process_generation").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    observationFingerprint: text("observation_fingerprint").notNull(),
    eventIdsJson: jsonb("event_ids_json").notNull(),
    recoveryObservationJson: jsonb("recovery_observation_json"),
  },
  (table) => [
    primaryKey({
      columns: [table.turnId, table.processGeneration, table.sequence],
    }),
    check(
      "harness_receipt_generation_check",
      sql`length(${table.processGeneration}) = 36`,
    ),
    check("harness_receipt_sequence_check", sql`${table.sequence} > 0`),
  ],
);

export const harnessProcessGenerations = pgTable("harness_process_generations", {
  turnId: text("turn_id").notNull().references(() => harnessBindings.turnId, { onDelete: "cascade" }),
  processGeneration: text("process_generation").notNull(),
  originJson: jsonb("origin_json").notNull(),
}, (table) => [
  primaryKey({ columns: [table.turnId, table.processGeneration] }),
  check("harness_generation_uuid_check", sql`length(${table.processGeneration}) = 36`),
]);

export const harnessConfiguredInstances=pgTable("harness_configured_instances",{
 userId:uuid("user_id").notNull(),workspaceId:text("workspace_id").notNull(),environmentId:text("environment_id").notNull(),instanceId:text("instance_id").notNull(),harness:text("harness").notNull(),connectionId:uuid("connection_id").notNull(),authOwnerGeneration:bigint("auth_owner_generation",{mode:"number"}).notNull(),createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.userId,t.workspaceId,t.environmentId,t.instanceId]}),check("harness_configured_kind_check",sql`${t.harness} IN ('codex','claude','opencode')`),check("harness_configured_generation_check",sql`${t.authOwnerGeneration}>0 AND ${t.authOwnerGeneration}<=9007199254740991`)]);
export const harnessNextSelections=pgTable("harness_next_selections",{
 userId:uuid("user_id").notNull(),workspaceId:text("workspace_id").notNull(),environmentId:text("environment_id").notNull(),sessionId:uuid("session_id").notNull(),threadId:text("thread_id").notNull(),revision:bigint("revision",{mode:"number"}).notNull(),selectionJson:jsonb("selection_json"),
},t=>[primaryKey({columns:[t.userId,t.workspaceId,t.environmentId,t.sessionId,t.threadId]}),check("harness_next_revision_check",sql`${t.revision}>=0 AND ${t.revision}<=9007199254740991`)]);
export const harnessControlCommandReceipts=pgTable("harness_control_command_receipts",{
 userId:uuid("user_id").notNull(),workspaceId:text("workspace_id").notNull(),environmentId:text("environment_id").notNull(),operation:text("operation").notNull(),scopeId:text("scope_id").notNull(),commandId:text("command_id").notNull(),requestFingerprint:text("request_fingerprint").notNull(),responseJson:jsonb("response_json").notNull(),createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.userId,t.workspaceId,t.environmentId,t.operation,t.scopeId,t.commandId]}),check("harness_command_operation_check",sql`${t.operation} IN ('setup','select')`)]);
export const harnessReplyClaims=pgTable("harness_reply_claims",{
 turnId:text("turn_id").notNull(),processGeneration:text("process_generation").notNull(),requestSequence:bigint("request_sequence",{mode:"number"}).notNull(),originJson:jsonb("origin_json").notNull(),claimedAt:timestamp("claimed_at",{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
},t=>[primaryKey({columns:[t.turnId,t.processGeneration,t.requestSequence]}),foreignKey({columns:[t.turnId,t.processGeneration,t.requestSequence],foreignColumns:[harnessObservationReceipts.turnId,harnessObservationReceipts.processGeneration,harnessObservationReceipts.sequence]}).onDelete("cascade")]);
