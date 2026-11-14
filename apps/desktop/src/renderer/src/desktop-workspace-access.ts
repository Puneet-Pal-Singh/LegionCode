import type { AppServerClient } from "@legioncode/sdk";
import type { LocalWorkspaceGrant, WorkspaceId } from "@repo/platform-protocol";
import type { WorkspaceSelection } from "../../shared/desktop-api";

export type DesktopWorkspaceAccessSource =
  | { kind: "folder"; selection: WorkspaceSelection }
  | { kind: "retained"; workspaceId: WorkspaceId };

type WorkspaceAccessResult =
  | { status: "selected"; grant: LocalWorkspaceGrant }
  | { status: "grant-required" }
  | { status: "superseded" };

/** Navigation metadata never grants access; only the App Server selects a retained grant. */
export async function acquireDesktopWorkspaceAccess(
  client: Pick<AppServerClient, "grantWorkspace" | "listWorkspaceGrants" | "selectWorkspaceGrant">,
  source: DesktopWorkspaceAccessSource,
  isCurrent: () => boolean,
): Promise<WorkspaceAccessResult> {
  if (!isCurrent()) return { status: "superseded" };
  if (source.kind === "folder") {
    const grant = await client.grantWorkspace({ selectionToken: source.selection.selectionToken });
    return isCurrent() ? { status: "selected", grant } : { status: "superseded" };
  }
  const grants = await client.listWorkspaceGrants();
  if (!isCurrent()) return { status: "superseded" };
  if (!grants.some((grant) => grant.workspaceId === source.workspaceId && grant.readiness === "ready")) {
    return { status: "grant-required" };
  }
  // Selection revalidates physical access at the canonical owner. Errors are
  // surfaced, rather than being misreported as a missing grant or picker intent.
  const grant = await client.selectWorkspaceGrant(source.workspaceId);
  return isCurrent() ? { status: "selected", grant } : { status: "superseded" };
}
