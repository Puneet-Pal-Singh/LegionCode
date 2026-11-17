import { isAbsolute } from "node:path";
import { z } from "zod";
import { LocalWorkspaceGrantPathSchema, LocalWorkspaceGrantSchema, type LocalWorkspaceGrant } from "@repo/platform-protocol";

const StoredGrantSchema = z.object({
  version: z.literal(1),
  path: LocalWorkspaceGrantPathSchema,
  grant: LocalWorkspaceGrantSchema,
}).strict();

export const LocalFilesystemWorkspaceIdentitySchema = z.object({
  device: z.string().regex(/^(?:0|[1-9a-f][0-9a-f]{0,15})(?![\s\S])/u),
  inode: z.string().regex(/^[1-9a-f][0-9a-f]{0,15}(?![\s\S])/u),
  birthtimeNs: z.string().regex(/^[1-9a-f][0-9a-f]{0,15}(?![\s\S])/u),
}).strict();
export type LocalFilesystemWorkspaceIdentity = z.infer<typeof LocalFilesystemWorkspaceIdentitySchema>;

export type StoredLocalWorkspaceGrant = {
  readonly version: 1;
  readonly path: string;
  readonly grant: LocalWorkspaceGrant;
} | {
  readonly version: 2;
  readonly path: string;
  readonly grant: LocalWorkspaceGrant;
  /** Opaque native identity; interpreted only by the canonical grant/NativeFS owner. */
  readonly gitMetadataIdentity: string;
} | {
  readonly version: 3;
  readonly path: string;
  readonly grant: LocalWorkspaceGrant;
  /** Actual held directory identity, never a synthetic Git metadata identity. */
  readonly filesystemIdentity: LocalFilesystemWorkspaceIdentity;
};

export function parseStoredGrant(value: unknown): StoredLocalWorkspaceGrant {
  // Legacy records remain readable, but only explicit grant can establish identity.
  const grant = z.union([
    StoredGrantSchema,
    z.object({
      version: z.literal(2),
      path: LocalWorkspaceGrantPathSchema,
      grant: LocalWorkspaceGrantSchema,
      gitMetadataIdentity: z.string().min(1).max(512),
    }).strict(),
    z.object({
      version: z.literal(3),
      path: LocalWorkspaceGrantPathSchema,
      grant: LocalWorkspaceGrantSchema,
      filesystemIdentity: LocalFilesystemWorkspaceIdentitySchema,
    }).strict().superRefine((record, context) => {
      if (record.grant.repositoryIdentity !== null || record.grant.branch !== null ||
          (record.grant.readiness === "ready"
            ? record.grant.capabilities.length !== 1 || record.grant.capabilities[0] !== "filesystem"
            : record.grant.capabilities.length !== 0)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Filesystem grant cannot carry Git authority" });
      }
    }),
  ]).parse(value);
  if (!isAbsolute(grant.path) || grant.path.includes("\0")) {
    throw new Error("Workspace grant path is invalid");
  }
  return grant;
}
