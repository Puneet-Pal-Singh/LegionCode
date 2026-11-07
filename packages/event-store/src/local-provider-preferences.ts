import type Database from "better-sqlite3";
import { WorkspaceIdSchema, type WorkspaceId } from "@repo/platform-protocol";
import { z } from "zod";

const RecordSchema = z
  .object({
    version: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    preferences: z.record(z.unknown()),
  })
  .strict();
const key = (workspaceId: WorkspaceId) =>
  `provider_preferences_v1:${WorkspaceIdSchema.parse(workspaceId)}`;

/** Secret-free records within the existing process-owned SQLite metadata table. */
export class LocalProviderPreferencesRecords {
  constructor(private readonly database: Database.Database) {}
  read(workspaceId: WorkspaceId): unknown | null {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(key(workspaceId)) as { value: string } | undefined;
    if (!row) return null;
    if (Buffer.byteLength(row.value) > 256 * 1024)
      throw new Error("Stored provider preferences exceed their bound");
    const record = RecordSchema.parse(JSON.parse(row.value));
    if (record.workspaceId !== workspaceId)
      throw new Error("Provider preferences scope is invalid");
    return record.preferences;
  }
  write(workspaceId: WorkspaceId, preferences: unknown): void {
    const value = JSON.stringify(
      RecordSchema.parse({ version: 1, workspaceId, preferences }),
    );
    if (Buffer.byteLength(value) > 256 * 1024)
      throw new Error("Provider preferences exceed their bound");
    this.database
      .transaction(() => {
        this.database
          .prepare(
            "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(key(workspaceId), value);
      })
      .immediate();
  }
}
