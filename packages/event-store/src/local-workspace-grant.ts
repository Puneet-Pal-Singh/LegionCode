import { isAbsolute } from "node:path";
import { z } from "zod";
import { LocalWorkspaceGrantPathSchema, LocalWorkspaceGrantSchema, type LocalWorkspaceGrant } from "@repo/platform-protocol";

const StoredGrantSchema = z.object({
  version: z.literal(1),
  path: LocalWorkspaceGrantPathSchema,
  grant: LocalWorkspaceGrantSchema,
}).strict();

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
  ]).parse(value);
  if (!isAbsolute(grant.path) || grant.path.includes("\0")) {
    throw new Error("Workspace grant path is invalid");
  }
  return grant;
}
