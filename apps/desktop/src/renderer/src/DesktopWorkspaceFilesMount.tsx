import type { WorkspaceId } from "@repo/platform-protocol";
import { useLayoutEffect, useState } from "react";
import {
  DesktopWorkspaceFiles,
  type DesktopWorkspaceFilesProps,
} from "./DesktopWorkspaceFiles";

interface Props {
  client: DesktopWorkspaceFilesProps["client"];
  workspaceId: WorkspaceId;
  availability: DesktopWorkspaceFilesProps["availability"];
}

/** Runtime availability comes from the handshake, never from method presence. */
export function DesktopWorkspaceFilesMount({
  client,
  workspaceId,
  availability,
}: Props) {
  const [scope, setScope] = useState({ client, workspaceId });
  const [refresh, setRefresh] = useState(0);
  useLayoutEffect(() => {
    setScope({ client, workspaceId });
    setRefresh(0);
  }, [client, workspaceId]);

  // Remove old-client content before allowing its replacement to issue reads.
  if (scope.client !== client || scope.workspaceId !== workspaceId)
    return <p role="status">Opening workspace files…</p>;
  return (
    <div className="space-y-3">
      {availability.available ? (
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh files
          </button>
        </div>
      ) : null}
      <DesktopWorkspaceFiles
        key={refresh}
        client={client}
        workspaceId={workspaceId}
        availability={availability}
      />
    </div>
  );
}
