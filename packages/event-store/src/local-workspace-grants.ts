import type Database from "better-sqlite3";
import { WorkspaceIdSchema, type WorkspaceId } from "@repo/platform-protocol";
import { LocalWorkspaceProjectRecords } from "./local-workspace-projects.js";
import { LocalPersistenceError } from "./errors.js";
import { parseStoredGrant, type StoredLocalWorkspaceGrant } from "./local-workspace-grant.js";

const SELECTION_KEY = "selected_workspace_id_v1";

/** Retained physical grants and their UI selection share the existing SQLite writer. */
export class LocalWorkspaceGrantRecords {
  constructor(private readonly database: Database.Database) {}

  read(workspaceId?: WorkspaceId): StoredLocalWorkspaceGrant | null {
    const id = workspaceId === undefined ? this.selectedId() : WorkspaceIdSchema.parse(workspaceId);
    if (id === null) return null;
    const row = this.database.prepare("SELECT value_json FROM workspace_grant WHERE workspace_id = ?")
      .get(id) as { value_json: string } | undefined;
    if (!row) {
      if (workspaceId === undefined) throw corrupt();
      return null;
    }
    return parseRow(id, row.value_json);
  }

  list(): readonly StoredLocalWorkspaceGrant[] {
    const rows = this.database.prepare("SELECT workspace_id, value_json FROM workspace_grant ORDER BY workspace_id")
      .all() as { workspace_id: string; value_json: string }[];
    return rows.map((row) => parseRow(row.workspace_id, row.value_json));
  }

  write(value: StoredLocalWorkspaceGrant, select = true): void {
    const parsed = parseStoredGrant(value);
    this.database.transaction(() => {
      // One physical repository cannot acquire two independent grant identities.
      for (const existing of this.list()) {
        if (existing.grant.workspaceId !== parsed.grant.workspaceId && existing.version === 2 && parsed.version === 2 &&
            existing.gitMetadataIdentity === parsed.gitMetadataIdentity) throw corrupt();
        if (existing.grant.workspaceId !== parsed.grant.workspaceId && existing.version === 3 && parsed.version === 3 &&
            existing.filesystemIdentity.device === parsed.filesystemIdentity.device &&
            existing.filesystemIdentity.inode === parsed.filesystemIdentity.inode &&
            existing.filesystemIdentity.birthtimeNs === parsed.filesystemIdentity.birthtimeNs) throw corrupt();
      }
      if (parsed.version === 2 && parsed.grant.readiness === "ready")
        new LocalWorkspaceProjectRecords(this.database).rememberValidated(parsed.grant, parsed.gitMetadataIdentity, select);
      if (parsed.version === 3 && parsed.grant.readiness === "ready")
        new LocalWorkspaceProjectRecords(this.database).rememberValidated(parsed.grant, parsed.filesystemIdentity, select);
      this.database.prepare(`INSERT INTO workspace_grant(workspace_id, value_json) VALUES (?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET value_json = excluded.value_json`)
        .run(parsed.grant.workspaceId, JSON.stringify(parsed));
      if (select) this.select(parsed.grant.workspaceId);
    }).immediate();
  }

  select(workspaceId: WorkspaceId): void {
    const id = WorkspaceIdSchema.parse(workspaceId);
    if (!this.read(id)) throw new LocalPersistenceError("unavailable", "Local workspace is not retained");
    this.database.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SELECTION_KEY, id);
  }

  clear(workspaceId?: WorkspaceId): void {
    this.database.transaction(() => {
      const id = workspaceId === undefined ? this.selectedId() : WorkspaceIdSchema.parse(workspaceId);
      if (id === null) return;
      this.database.prepare("DELETE FROM workspace_grant WHERE workspace_id = ?").run(id);
      this.database.prepare("DELETE FROM metadata WHERE key = ? AND value = ?").run(SELECTION_KEY, id);
    }).immediate();
  }

  validate(): void {
    const grants = this.list();
    const identities = new Set<string>();
    for (const grant of grants) {
      const identity = grant.version === 2 ? `git:${grant.gitMetadataIdentity}` : grant.version === 3
        ? `filesystem:${grant.filesystemIdentity.device}:${grant.filesystemIdentity.inode}:${grant.filesystemIdentity.birthtimeNs}` : null;
      if (identity === null) continue;
      if (identities.has(identity)) throw corrupt();
      identities.add(identity);
    }
    this.read();
    new LocalWorkspaceProjectRecords(this.database).list();
  }

  private selectedId(): WorkspaceId | null {
    const row = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get(SELECTION_KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = WorkspaceIdSchema.safeParse(row.value);
    if (!parsed.success) throw corrupt();
    return parsed.data;
  }
}

function parseRow(id: string, json: string): StoredLocalWorkspaceGrant {
  try {
    const parsed = parseStoredGrant(JSON.parse(json));
    if (parsed.grant.workspaceId !== WorkspaceIdSchema.parse(id)) throw corrupt();
    return parsed;
  } catch { throw corrupt(); }
}

function corrupt(): LocalPersistenceError {
  return new LocalPersistenceError("corrupt", "Retained local workspace grant identity is invalid");
}
