import type Database from "better-sqlite3";
import {
  LocalWorkspaceProjectSchema,
  WorkspaceIdSchema,
  type LocalWorkspaceGrant,
  type LocalWorkspaceProject,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { z } from "zod";

const PREFIX = "workspace_project_v1:";
const KnownRecordSchema = z.object({
  version: z.literal(1),
  project: LocalWorkspaceProjectSchema,
  /** Private, opaque native identity. Never returned through the protocol. */
  gitMetadataIdentity: z.string().min(1).max(16_384).nullable(),
}).strict().superRefine((record, context) => {
  if ((record.project.association === "known") !== (record.gitMetadataIdentity !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Workspace project association is invalid" });
  }
});
type RecordValue = z.infer<typeof KnownRecordSchema>;

/** Part of workspaceGrants, inside the same SQLite writer and transaction. No paths. */
export class LocalWorkspaceProjectRecords {
  constructor(private readonly database: Database.Database) {}

  list(): LocalWorkspaceProject[] {
    return this.readAll().map(({ project }) => project).sort((left, right) =>
      (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "") || left.workspaceId.localeCompare(right.workspaceId));
  }

  findWorkspaceId(gitMetadataIdentity: string): WorkspaceId | null {
    return this.readAll().find((record) => record.gitMetadataIdentity === gitMetadataIdentity)?.project.workspaceId ?? null;
  }

  rememberValidated(grant: LocalWorkspaceGrant, gitMetadataIdentity: string): void {
    const existing = this.readAll();
    const association = existing.find((record) => record.gitMetadataIdentity === gitMetadataIdentity);
    const previous = existing.find((record) => record.project.workspaceId === grant.workspaceId);
    if ((association && association.project.workspaceId !== grant.workspaceId) ||
        (previous?.gitMetadataIdentity && previous.gitMetadataIdentity !== gitMetadataIdentity)) {
      throw new Error("Workspace project identity conflicts with its known association");
    }
    const next: RecordValue = {
      version: 1,
      project: {
        association: "known", workspaceId: grant.workspaceId, displayName: grant.displayName,
        repositoryIdentity: grant.repositoryIdentity, lastOpenedAt: grant.grantedAt,
      },
      gitMetadataIdentity,
    };
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.write(next);
  }

  rememberUnlinked(workspaceIds: readonly WorkspaceId[]): void {
    const known = new Set(this.readAll().map(({ project }) => project.workspaceId));
    for (const workspaceId of workspaceIds) {
      WorkspaceIdSchema.parse(workspaceId);
      if (known.has(workspaceId)) continue;
      this.write({
        version: 1,
        project: { association: "unlinked", workspaceId, displayName: null, repositoryIdentity: null, lastOpenedAt: null },
        gitMetadataIdentity: null,
      });
      known.add(workspaceId);
    }
  }

  private readAll(): RecordValue[] {
    const rows = this.database.prepare("SELECT key, value FROM metadata WHERE key GLOB ?").all(`${PREFIX}*`) as { key: string; value: string }[];
    const identities = new Set<string>();
    return rows.map((row) => {
      if (Buffer.byteLength(row.value) > 32_768) throw new Error("Stored workspace project exceeds its bound");
      const record = KnownRecordSchema.parse(JSON.parse(row.value));
      if (row.key !== `${PREFIX}${record.project.workspaceId}`) throw new Error("Stored workspace project scope is invalid");
      if (record.gitMetadataIdentity !== null) {
        if (identities.has(record.gitMetadataIdentity)) throw new Error("Stored workspace project identity is duplicated");
        identities.add(record.gitMetadataIdentity);
      }
      return record;
    });
  }

  private write(input: RecordValue): void {
    const record = KnownRecordSchema.parse(input);
    this.database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`${PREFIX}${record.project.workspaceId}`, JSON.stringify(record));
  }
}
