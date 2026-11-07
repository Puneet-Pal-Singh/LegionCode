import { SharedFileExplorer, type FileExplorerReadPort } from "@legioncode/client-ui";
import type { AppServerClient } from "@legioncode/sdk";
import type { WorkspaceId } from "@repo/platform-protocol";
import { useCallback, useEffect, useState } from "react";

type FilesClient = Pick<AppServerClient, "listWorkspaceFiles" | "readWorkspaceFile">;
export interface DesktopWorkspaceFilesProps {
  client: FilesClient;
  workspaceId: WorkspaceId | null;
  availability: { available: true } | { available: false; reason: string };
}

export function DesktopWorkspaceFiles({ client, workspaceId, availability }: DesktopWorkspaceFilesProps) {
  if (!workspaceId) return <p role="status">Choose a folder and grant access to browse files.</p>;
  if (!availability.available) return <p role="status">Workspace files unavailable: {availability.reason}</p>;
  return <WorkspaceFiles key={workspaceId} client={client} workspaceId={workspaceId} />;
}

function WorkspaceFiles({ client, workspaceId }: { client: FilesClient; workspaceId: WorkspaceId }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const listFiles: FileExplorerReadPort = useCallback(async (path, cursor, signal) => {
    if (cursor !== null && typeof cursor !== "string") throw new Error("Invalid native directory cursor");
    signal.throwIfAborted();
    const page = await client.listWorkspaceFiles({ workspaceId, path, cursor });
    signal.throwIfAborted();
    return {
      entries: page.entries.map((entry) => ({
        name: entry.name, path: entry.path, type: entry.kind, unavailableReason: entry.unavailableReason ? "Reserved workspace path" : undefined,
      })),
      nextCursor: page.nextCursor,
    };
  }, [client, workspaceId]);
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <SharedFileExplorer scopeKey={workspaceId} enabled listFiles={listFiles} onFileClick={setSelectedPath} showFilter />
      {selectedPath ? <FilePreview key={selectedPath} client={client} workspaceId={workspaceId} path={selectedPath} /> : null}
    </div>
  );
}

type PreviewRead = { client: FilesClient } & (
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; output: string; isBinary: boolean }
);
function FilePreview({ client, workspaceId, path }: { client: FilesClient; workspaceId: WorkspaceId; path: string }) {
  const [read, setRead] = useState<PreviewRead>({ client, status: "loading" });
  useEffect(() => {
    let active = true;
    setRead({ client, status: "loading" });
    void client.readWorkspaceFile({ workspaceId, path }).then((result) => {
      if (active) setRead({ client, status: "ready", ...result });
    }).catch((error: unknown) => {
      if (active) setRead({ client, status: "error", message: error instanceof Error ? error.message : "Workspace file could not be read." });
    });
    return () => { active = false; };
  }, [client, workspaceId, path]);
  return (
    <section aria-label="Current workspace file preview" className="min-w-0 border-t border-zinc-800 pt-3">
      <h3 className="break-all font-mono text-xs text-zinc-300">{path}</h3>
      <p className="my-2 text-xs text-zinc-500">Current workspace content; separate from saved turn review.</p>
      {read.client !== client || read.status === "loading" ? <p role="status">Loading file…</p>
        : read.status === "error" ? <p role="alert">{read.message}</p>
        : read.isBinary ? <p role="status">Binary file content is not displayed.</p>
        : read.output === "" ? <p role="status">Empty file.</p>
        : <pre className="max-h-96 overflow-auto whitespace-pre text-xs text-zinc-300">{read.output}</pre>}
    </section>
  );
}
