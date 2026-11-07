import type { LocalWorkspaceGrant } from "@repo/platform-protocol";

/** Narrow consumer port of the host grant owner's bindForExecution handle. */
export interface LocalReadOnlyWorkspaceBinding {
  readonly workspace: Pick<LocalWorkspaceGrant, "workspaceId">;
  readonly filesystemRoot: string;
  readonly signal: AbortSignal;
  assertCurrent(): void | Promise<void>;
}
