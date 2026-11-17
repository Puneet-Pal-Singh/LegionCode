import type Database from "better-sqlite3";
import {
  LocalWorkspaceProjectSchema,
  LocalWorkspaceGrantSchema,
  WorkspaceIdSchema,
  type LocalWorkspaceGrant,
  type LocalWorkspaceProject,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { z } from "zod";
import { LocalFilesystemWorkspaceIdentitySchema, type LocalFilesystemWorkspaceIdentity } from "./local-workspace-grant.js";

const PREFIX = "workspace_project_v1:";
// Retain old private records verbatim; sanitize their navigation projection.
const StoredProjectSchema = z.discriminatedUnion("association", [
  LocalWorkspaceProjectSchema.options[0].extend({ repositoryIdentity: LocalWorkspaceGrantSchema.shape.repositoryIdentity }),
  LocalWorkspaceProjectSchema.options[1],
]);
const GitRecordSchema = z.object({
  version: z.literal(1),
  project: StoredProjectSchema,
  hidden: z.boolean().default(false),
  /** Private, opaque native identity. Never returned through the protocol. */
  gitMetadataIdentity: z.string().min(1).max(16_384).nullable(),
}).strict().superRefine((record, context) => {
  if ((record.project.association === "known") !== (record.gitMetadataIdentity !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Workspace project association is invalid" });
  }
});
const KnownRecordSchema = z.union([
  GitRecordSchema,
  z.object({
    version: z.literal(2),
    project: LocalWorkspaceProjectSchema.options[0],
    hidden: z.boolean(),
    filesystemIdentity: LocalFilesystemWorkspaceIdentitySchema,
  }).strict(),
]);
type RecordValue = z.infer<typeof KnownRecordSchema>;

/** Part of workspaceGrants, inside the same SQLite writer and transaction. No paths. */
export class LocalWorkspaceProjectRecords {
  constructor(private readonly database: Database.Database) {}

  list(): LocalWorkspaceProject[] {
    return this.readAll().filter((record) => !record.hidden).map(({ project }) =>
      project.association === "known" ? { ...project, repositoryIdentity: null } : project).sort((left, right) =>
      (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "") || left.workspaceId.localeCompare(right.workspaceId));
  }

  findWorkspaceId(identity: string | LocalFilesystemWorkspaceIdentity): WorkspaceId | null {
    const key = associationKey(identity);
    return this.readAll().find((record) => recordAssociationKey(record) === key)?.project.workspaceId ?? null;
  }

  rememberValidated(grant: LocalWorkspaceGrant, identity: string | LocalFilesystemWorkspaceIdentity, restoreHidden = false): void {
    const existing = this.readAll();
    const key = associationKey(identity);
    const association = existing.find((record) => recordAssociationKey(record) === key);
    const previous = existing.find((record) => record.project.workspaceId === grant.workspaceId);
    if ((association && association.project.workspaceId !== grant.workspaceId) ||
        (previous && recordAssociationKey(previous) !== null && recordAssociationKey(previous) !== key)) {
      throw new Error("Workspace project identity conflicts with its known association");
    }
    const project = {
        association: "known", workspaceId: grant.workspaceId, displayName: grant.displayName,
        repositoryIdentity: null, lastOpenedAt: grant.grantedAt,
    } as const;
    const next: RecordValue = typeof identity === "string" ? {
      version: 1, project, gitMetadataIdentity: identity,
      hidden: restoreHidden ? false : previous?.hidden ?? false,
    } : {
      version: 2, project, filesystemIdentity: { ...identity },
      hidden: restoreHidden ? false : previous?.hidden ?? false,
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
        hidden: false,
      });
      known.add(workspaceId);
    }
  }

  hide(workspaceId: WorkspaceId): void {
    const record = this.readAll().find((item) => item.project.workspaceId === workspaceId);
    if (!record) throw new Error("Local project is unavailable");
    this.write({ ...record, hidden: true });
  }

  private readAll(): RecordValue[] {
    const rows = this.database.prepare("SELECT key, value FROM metadata WHERE key GLOB ?").all(`${PREFIX}*`) as { key: string; value: string }[];
    const identities = new Set<string>();
    return rows.map((row) => {
      if (Buffer.byteLength(row.value) > 32_768) throw new Error("Stored workspace project exceeds its bound");
      const record = KnownRecordSchema.parse(JSON.parse(row.value));
      if (row.key !== `${PREFIX}${record.project.workspaceId}`) throw new Error("Stored workspace project scope is invalid");
      const identity = recordAssociationKey(record);
      if (identity !== null) {
        if (identities.has(identity)) throw new Error("Stored workspace project identity is duplicated");
        identities.add(identity);
      }
      return record;
    });
  }

  private write(input: RecordValue): void {
    const record = KnownRecordSchema.parse(input);
    const value = JSON.stringify(record);
    if (Buffer.byteLength(value) > 32_768) throw new Error("Workspace project exceeds its storage bound");
    this.database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`${PREFIX}${record.project.workspaceId}`, value);
  }
}

function associationKey(identity: string | LocalFilesystemWorkspaceIdentity): string {
  return typeof identity === "string" ? `git:${identity}` : `filesystem:${identity.device}:${identity.inode}:${identity.birthtimeNs}`;
}
function recordAssociationKey(record: RecordValue): string | null {
  return record.version === 2 ? associationKey(record.filesystemIdentity)
    : record.gitMetadataIdentity === null ? null : associationKey(record.gitMetadataIdentity);
}
