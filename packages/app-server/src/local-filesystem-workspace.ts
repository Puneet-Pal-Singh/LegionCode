import { basename } from "node:path";
import type { LocalFilesystemWorkspaceIdentity, StoredLocalWorkspaceGrant } from "@repo/event-store/local";
import { LocalWorkspaceGrantSchema, type WorkspaceId } from "@repo/platform-protocol";
import type { LocalWorkspaceRootPin } from "./local-workspace-root-pin.js";

export type StoredFilesystemWorkspaceGrant = Extract<StoredLocalWorkspaceGrant, { version: 3 }>;

/** The grant owner's actual held directory identity; no Git metadata is made. */
export async function readFilesystemWorkspaceIdentity(pin: LocalWorkspaceRootPin): Promise<LocalFilesystemWorkspaceIdentity> {
  pin.assertCurrent();
  const root = await pin.rootDirectory.stat({ bigint: true });
  await pin.assertPathCurrent();
  if (!root.isDirectory() || root.ino <= 0n || typeof root.birthtimeNs !== "bigint" || root.birthtimeNs <= 0n)
    throw new Error("Filesystem workspace root requires a supported physical birth identity");
  return Object.freeze({ device: root.dev.toString(16), inode: root.ino.toString(16), birthtimeNs: root.birthtimeNs.toString(16) });
}

export async function assertFilesystemWorkspaceIdentity(pin: LocalWorkspaceRootPin, stored: StoredFilesystemWorkspaceGrant): Promise<void> {
  const current = await readFilesystemWorkspaceIdentity(pin);
  if (current.device !== stored.filesystemIdentity.device || current.inode !== stored.filesystemIdentity.inode ||
      current.birthtimeNs !== stored.filesystemIdentity.birthtimeNs)
    throw new Error("Filesystem workspace directory identity changed; explicit regrant is required");
}

export function buildFilesystemWorkspaceGrant(path: string, workspaceId: WorkspaceId) {
  return LocalWorkspaceGrantSchema.parse({
    workspaceId, displayName: basename(path), repositoryIdentity: null, branch: null,
    readiness: "ready", capabilities: ["filesystem"],
    reason: "Folder access is ready for file browsing. Native execution and Git review are not available for this folder.",
    grantedAt: new Date().toISOString(),
  });
}
