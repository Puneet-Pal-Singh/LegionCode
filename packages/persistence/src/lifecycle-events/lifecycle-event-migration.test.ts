import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { lifecycleEventsProjectionsMigration } from "../migrations/0020-lifecycle-events-projections.js";

describe("lifecycle event persistence migration", () => {
  it("registers durable event and projection tables after their dependencies", async () => {
    expect(persistenceMigrations).toContain(
      lifecycleEventsProjectionsMigration,
    );
    const sql = lifecycleEventsProjectionsMigration.statements.join("\n");
    expect(sql).toContain("canonical_lifecycle_events");
    expect(sql).toContain("canonical_lifecycle_projections");
    expect(sql).toContain("turn_id, sequence");
    expect(sql).toContain("turn_id, idempotency_key");
    const ids = persistenceMigrations.map((migration) => migration.id);
    const ordered = ["0032_chat_durability", "0035_harness_bindings", "0037_provider_connection_custody", "0038_harness_control_plane", "0039_harness_recovery_reply_claims"];
    expect(ids).toEqual(expect.arrayContaining(ordered));
    for (let index = 1; index < ordered.length; index++) {
      expect(ids.indexOf(ordered[index]!)).toBeGreaterThan(ids.indexOf(ordered[index - 1]!));
    }
    expect(new Set(ids).size).toBe(ids.length);

    const db = new PGlite();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const connectedId = randomUUID();
    const revokedId = randomUUID();
    try {
      for (const migration of persistenceMigrations) {
        if (migration.id === "0037_provider_connection_custody") {
          // Upgrade existing rows, including revoked credentials that must not
          // become usable defaults when connection-scoped custody is enabled.
          await db.query("INSERT INTO users(id,display_name) VALUES($1,'migration fixture')", [userId]);
          await db.query("INSERT INTO provider_credentials(id,user_id,workspace_id,provider_id,label,key_fingerprint,encrypted_secret_json,key_version,status) VALUES($1,$3,$4,'codex','connected','fixture-connected','{}'::jsonb,'fixture','connected'),($2,$3,$4,'opencode','revoked','fixture-revoked','{}'::jsonb,'fixture','revoked')", [connectedId, revokedId, userId, workspaceId]);
        }
        for (const statement of migration.statements) {
          if (!statement.includes("CREATE EXTENSION IF NOT EXISTS pgcrypto")) await db.exec(statement);
        }
      }
      expect((await db.query("SELECT id,is_default,auth_owner_generation::integer,token_material_version::integer,credential_kind FROM provider_credentials ORDER BY provider_id")).rows).toEqual([
        { id: connectedId, is_default: true, auth_owner_generation: 1, token_material_version: 1, credential_kind: "api_key" },
        { id: revokedId, is_default: false, auth_owner_generation: 1, token_material_version: 1, credential_kind: "api_key" },
      ]);
      expect((await db.query("SELECT provider_id,generation::integer FROM provider_credential_default_epochs ORDER BY provider_id")).rows).toEqual([
        { provider_id: "codex", generation: 1 }, { provider_id: "opencode", generation: 1 },
      ]);
      await expect(db.query("UPDATE provider_credentials SET auth_owner_generation=0 WHERE id=$1", [connectedId])).rejects.toThrow();
      await expect(db.query("UPDATE provider_credentials SET token_material_version=0 WHERE id=$1", [connectedId])).rejects.toThrow();
      await expect(db.query("UPDATE provider_credential_default_epochs SET generation=0 WHERE user_id=$1", [userId])).rejects.toThrow();
      // Multiple connections are valid, but only one live default per provider.
      const additionalId = randomUUID();
      await db.query("INSERT INTO provider_credentials(id,user_id,workspace_id,provider_id,label,key_fingerprint,encrypted_secret_json,key_version,is_default) VALUES($1,$2,$3,'codex','additional','fixture-additional','{}'::jsonb,'fixture',FALSE)", [additionalId, userId, workspaceId]);
      await expect(db.query("UPDATE provider_credentials SET is_default=TRUE WHERE id=$1", [additionalId])).rejects.toThrow();
      await expect(db.query("INSERT INTO harness_configured_instances(user_id,workspace_id,environment_id,instance_id,harness,connection_id,auth_owner_generation) VALUES($1,$2,'local','instance','codex',$3,0)", [userId, workspaceId, connectedId])).rejects.toThrow();
      await expect(db.query("INSERT INTO harness_configured_instances(user_id,workspace_id,environment_id,instance_id,harness,connection_id,auth_owner_generation) VALUES($1,$2,'local','instance','codex',$3,1)", [userId, workspaceId, randomUUID()])).rejects.toThrow();
      await expect(db.query("INSERT INTO harness_reply_claims(turn_id,process_generation,request_sequence,origin_json) VALUES('missing-turn','11111111-1111-4111-8111-111111111111',1,'{}'::jsonb)")).rejects.toThrow();
      const columns = await db.query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE (table_name='canonical_turn_admissions' AND column_name='harness_admission_receipt_json') OR (table_name='harness_observation_receipts' AND column_name='recovery_observation_json') OR (table_name='harness_next_selections' AND column_name IN ('revision','selection_json')) ORDER BY table_name,column_name");
      expect(columns.rows).toEqual([
        { table_name: "canonical_turn_admissions", column_name: "harness_admission_receipt_json", data_type: "jsonb", is_nullable: "YES" },
        { table_name: "harness_next_selections", column_name: "revision", data_type: "bigint", is_nullable: "NO" },
        { table_name: "harness_next_selections", column_name: "selection_json", data_type: "jsonb", is_nullable: "YES" },
        { table_name: "harness_observation_receipts", column_name: "recovery_observation_json", data_type: "jsonb", is_nullable: "YES" },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("registers the committed lifecycle SQL in the Drizzle journal", () => {
    const journal = readFileSync(
      join(process.cwd(), "drizzle", "meta", "_journal.json"),
      "utf8",
    );

    expect(journal).toContain('"tag": "0020_lifecycle_events_projections"');
  });
});
