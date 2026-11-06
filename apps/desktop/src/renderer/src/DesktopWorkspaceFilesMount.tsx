import type { AppServerClient } from "@legioncode/sdk";
import type { WorkspaceId } from "@repo/platform-protocol";
import { useEffect, useState } from "react";
import { DesktopWorkspaceFiles } from "./DesktopWorkspaceFiles";

type FilesClient = Pick<AppServerClient, "listWorkspaceFiles" | "readWorkspaceFile">;
type Readiness = { client: FilesClient; workspaceId: WorkspaceId } & (
  | { status: "checking" }
  | { status: "ready" }
  | { status: "error"; message: string }
);

/** Confirm the actual granted read service; method presence is not availability. */
export function DesktopWorkspaceFilesMount({ client, workspaceId }: { client: FilesClient; workspaceId: WorkspaceId }) {
  const [readiness, setReadiness] = useState<Readiness>({ client, workspaceId, status: "checking" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setReadiness({ client, workspaceId, status: "checking" });
    void client.listWorkspaceFiles({ workspaceId, path: ".", limit: 1 }).then(() => {
      if (active) setReadiness({ client, workspaceId, status: "ready" });
    }).catch((error: unknown) => {
      if (active) setReadiness({ client, workspaceId, status: "error", message: error instanceof Error ? error.message : "Local workspace reads could not be confirmed." });
    });
    return () => { active = false; };
  }, [client, workspaceId, retry]);

  if (readiness.client !== client || readiness.workspaceId !== workspaceId || readiness.status === "checking") {
    return <p role="status">Opening workspace files…</p>;
  }
  if (readiness.status === "error") return (
    <div className="space-y-3">
      <p role="alert">{readiness.message}</p>
      <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry workspace files</button>
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200" onClick={() => setRetry((value) => value + 1)}>Refresh files</button>
      </div>
      <DesktopWorkspaceFiles key={workspaceId} client={client} workspaceId={workspaceId} availability={{ available: true }} />
    </div>
  );
}
