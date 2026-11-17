import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { providerConnectionCustodyMigration } from "./0037-provider-connection-custody.js";
import { workspaceConfigurationVersionMigration } from "./0041-workspace-configuration-version.js";
import { nativeProviderAdmissionBindingMigration } from "./0042-native-provider-admission-binding.js";
import { taskCheckoutIssuanceMigration } from "./0043-task-checkout-issuance.js";
import { harnessBindingsMigration } from "./0045-harness-bindings.js";

import { PostgresMigrationRunner } from "./PostgresMigrationRunner.js";
import { projectlessSessionRepositoryMigration } from "./0034-projectless-session-repository.js";
import { artifactProvenanceMigration } from "./0024-artifact-provenance.js";
import { legacyHistoryImportReceiptsMigration } from "./0034-legacy-history-import-receipts.js";
import type { MigrationLedger, SqlMigration } from "./types.js";
import type { SqlClient, SqlQueryResult, SqlRow } from "../sql.js";

class RecordingSqlClient implements SqlClient {
  public readonly statements: string[] = [];

  constructor(
    private readonly failureStatement?: string,
    private readonly failureError: unknown = new Error(
      "database rejected statement",
    ),
  ) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push(statement);
    if (statement === this.failureStatement) {
      throw this.failureError;
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

class FakeLedger implements MigrationLedger {
  public readonly recorded: string[] = [];

  constructor(private readonly appliedIds: Set<string>) {}

  async ensureReady(): Promise<void> {}

  async hasMigration(
    _client: SqlClient,
    migrationId: string,
  ): Promise<boolean> {
    return this.appliedIds.has(migrationId);
  }

  async recordMigration(
    _client: SqlClient,
    migration: SqlMigration,
  ): Promise<void> {
    this.recorded.push(migration.id);
  }
}

describe("PostgresMigrationRunner", () => {
  it("defines the artifact provenance columns and lookup index", () => {
    expect(artifactProvenanceMigration.id).toBe("0024_artifact_provenance");
    expect(artifactProvenanceMigration.statements).toHaveLength(2);
    expect(artifactProvenanceMigration.statements[0]).toContain("thread_id");
    expect(artifactProvenanceMigration.statements[0]).toContain("turn_id");
    expect(artifactProvenanceMigration.statements[0]).toContain(
      "run_attempt_id",
    );
    expect(artifactProvenanceMigration.statements[1]).toContain(
      "artifacts_provenance_lookup_idx",
    );
    expect(artifactProvenanceMigration.statements[1]).toContain(
      "assistant_message_id",
    );
  });

  it("applies only pending migrations", async () => {
    const client = new RecordingSqlClient();
    const ledger = new FakeLedger(new Set(["0001_done"]));
    const runner = new PostgresMigrationRunner(client, ledger);

    const result = await runner.runPending([
      { id: "0001_done", description: "done", statements: ["SELECT 1"] },
      { id: "0002_pending", description: "pending", statements: ["SELECT 2"] },
      legacyHistoryImportReceiptsMigration,
      projectlessSessionRepositoryMigration,
      providerConnectionCustodyMigration,
      workspaceConfigurationVersionMigration,
      nativeProviderAdmissionBindingMigration,
      taskCheckoutIssuanceMigration,
      harnessBindingsMigration,
    ]);

    expect(result).toEqual({
      applied: [
        "0002_pending",
        "0034_legacy_history_import_receipts",
        "0034_projectless_session_repository",
        "0037_provider_connection_custody",
        "0041_workspace_configuration_version",
        "0042_native_provider_admission_binding",
        "0043_task_checkout_issuance",
        "0045_harness_bindings",
      ],
      skipped: ["0001_done"],
    });
    expect(client.statements).toEqual([
      "SELECT pg_advisory_xact_lock(hashtext('legioncode:persistence:migrations')::bigint)",
      "SELECT 2",
      ...legacyHistoryImportReceiptsMigration.statements,
      ...projectlessSessionRepositoryMigration.statements,
      ...providerConnectionCustodyMigration.statements,
      ...workspaceConfigurationVersionMigration.statements,
      ...nativeProviderAdmissionBindingMigration.statements,
      ...taskCheckoutIssuanceMigration.statements,
      ...harnessBindingsMigration.statements,

    ]);
    expect(ledger.recorded).toEqual([
      "0002_pending",
      "0034_legacy_history_import_receipts",
      "0034_projectless_session_repository",
      "0037_provider_connection_custody",
      "0041_workspace_configuration_version",
      "0042_native_provider_admission_binding",
      "0043_task_checkout_issuance",
      "0045_harness_bindings",
    ]);
    expect(legacyHistoryImportReceiptsMigration.statements[1]).toContain(
      "FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id) ON DELETE RESTRICT",
    );
    expect(legacyHistoryImportReceiptsMigration.statements[2]).toContain(
      "WHERE source_kind = 'durable_object_export'",
    );
    expect(legacyHistoryImportReceiptsMigration.statements[3]).toContain(
      "WHERE source_kind = 'local_wrangler_sqlite'",
    );
    expect(workspaceConfigurationVersionMigration.statements).toEqual([
      "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS configuration_version INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE workspaces ADD CONSTRAINT workspaces_configuration_version_positive_check CHECK (configuration_version > 0)",
    ]);
    expect(projectlessSessionRepositoryMigration.statements[0]).toContain(
      "UPDATE sessions SET repository = NULL WHERE repository = 'New Project'",
    );
    const alreadyApplied = new PostgresMigrationRunner(
      client,
      new FakeLedger(new Set(ledger.recorded)),
    );
    expect(
      await alreadyApplied.runPending([
        projectlessSessionRepositoryMigration,
        providerConnectionCustodyMigration,
        workspaceConfigurationVersionMigration,
        nativeProviderAdmissionBindingMigration,
        taskCheckoutIssuanceMigration,
        harnessBindingsMigration,
      ]),
    ).toEqual({
      applied: [],
      skipped: [
        "0034_projectless_session_repository",
        "0037_provider_connection_custody",
        "0041_workspace_configuration_version",
        "0042_native_provider_admission_binding",
        "0043_task_checkout_issuance",
        "0045_harness_bindings",
      ],
    });

    // The additive private column keeps historical rows unbound; migration must
    // never choose today's credential or rewrite an existing admission payload.
    const legacy = new PGlite();
    try {
      await legacy.exec("CREATE TABLE canonical_turn_admissions (turn_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL); INSERT INTO canonical_turn_admissions VALUES ('trn_legacy', 'original-fingerprint')");
      for (const statement of nativeProviderAdmissionBindingMigration.statements) await legacy.exec(statement);
      expect((await legacy.query("SELECT turn_id, request_fingerprint, native_provider_binding_json FROM canonical_turn_admissions")).rows)
        .toEqual([{ turn_id: "trn_legacy", request_fingerprint: "original-fingerprint", native_provider_binding_json: null }]);
      expect((await legacy.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'canonical_turn_admissions' AND column_name = 'native_provider_binding_json'")).rows)
        .toEqual([{ is_nullable: "YES", column_default: null }]);
    } finally { await legacy.close(); }

  });

  it("adds migration context to statement failures", async () => {
    const client = new RecordingSqlClient("SELECT broken");
    const ledger = new FakeLedger(new Set());
    const runner = new PostgresMigrationRunner(client, ledger);

    await expect(
      runner.runPending([
        {
          id: "0001_broken",
          description: "broken",
          statements: ["SELECT ok", "SELECT broken"],
        },
      ]),
    ).rejects.toThrow(
      "Failed to apply migration 0001_broken statement 2: database rejected statement",
    );
  });

  it("handles non-Error throwables with detail preservation", async () => {
    const client = new RecordingSqlClient(
      "SELECT broken",
      "custom string error",
    );
    const ledger = new FakeLedger(new Set());
    const runner = new PostgresMigrationRunner(client, ledger);

    await expect(
      runner.runPending([
        {
          id: "0001_broken",
          description: "broken",
          statements: ["SELECT broken"],
        },
      ]),
    ).rejects.toThrow(
      "Failed to apply migration 0001_broken statement 1: custom string error",
    );
  });

  it("handles object throwables by stringifying them", async () => {
    const client = new RecordingSqlClient("SELECT broken", {
      code: "X123",
      detail: "object error",
    });
    const ledger = new FakeLedger(new Set());
    const runner = new PostgresMigrationRunner(client, ledger);

    await expect(
      runner.runPending([
        {
          id: "0001_broken",
          description: "broken",
          statements: ["SELECT broken"],
        },
      ]),
    ).rejects.toThrow(
      'Failed to apply migration 0001_broken statement 1: {"code":"X123","detail":"object error"}',
    );
  });
});
