import {
  SharedFileExplorer,
  WorkspaceContentView,
  WorkspaceTreeDrawer,
  type FileExplorerReadPort,
} from "@legioncode/client-ui";
import type { DesktopRightPanelControls } from "./DesktopRightPanel";
import type { ReactNode } from "react";
import type { AppServerClient } from "@legioncode/sdk";
import type { WorkspaceId } from "@repo/platform-protocol";
import { useCallback, useEffect, useState } from "react";

type FilesClient = Pick<
  AppServerClient,
  "listWorkspaceFiles" | "readWorkspaceFile"
>;
export interface DesktopWorkspaceFilesProps {
  client: FilesClient;
  workspaceId: WorkspaceId | null;
  availability: { available: true } | { available: false; reason: string };
  controls: DesktopRightPanelControls;
}

export function DesktopWorkspaceFiles({
  client,
  workspaceId,
  availability,
  controls,
}: DesktopWorkspaceFilesProps) {
  if (!workspaceId || !availability.available)
    return (
      <UnavailableFiles
        controls={controls}
        reason={
          !workspaceId
            ? "Choose a folder and grant access to browse files."
            : !availability.available
              ? `Workspace files unavailable: ${availability.reason}`
              : ""
        }
      />
    );
  return (
    <WorkspaceFiles
      key={workspaceId}
      client={client}
      workspaceId={workspaceId}
      controls={controls}
    />
  );
}

function WorkspaceFiles({
  client,
  workspaceId,
  controls,
}: {
  client: FilesClient;
  workspaceId: WorkspaceId;
  controls: DesktopRightPanelControls;
}) {
  const selectedPath = controls.selectedPath;
  const filesOpen = controls.isFilesOpen;
  const toggleFiles = controls.onToggleFiles;
  const listFiles: FileExplorerReadPort = useCallback(
    async (path, cursor, signal) => {
      if (cursor !== null && typeof cursor !== "string")
        throw new Error("Invalid native directory cursor");
      signal.throwIfAborted();
      const page = await client.listWorkspaceFiles({
        workspaceId,
        path,
        cursor,
      });
      signal.throwIfAborted();
      return {
        entries: page.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.kind,
          unavailableReason: entry.unavailableReason
            ? "Reserved workspace path"
            : undefined,
        })),
        nextCursor: page.nextCursor,
      };
    },
    [client, workspaceId],
  );
  return (
    <FilePreview
      client={client}
      workspaceId={workspaceId}
      path={selectedPath}
      filesOpen={filesOpen}
      onToggleFiles={toggleFiles}
      tree={
        <SharedFileExplorer
          scopeKey={workspaceId}
          enabled
          listFiles={listFiles}
          onFileClick={controls.onSelectFile}
          showFilter
        />
      }
    />
  );
}

function UnavailableFiles({
  controls,
  reason,
}: {
  controls: DesktopRightPanelControls;
  reason: string;
}) {
  const filesOpen = controls.isFilesOpen;
  const onToggleFiles = controls.onToggleFiles;
  return (
    <div className="relative h-full min-h-0">
      <WorkspaceContentView
        selectedFile={null}
        selectedDiff={null}
        isLoading={false}
        filesOpen={filesOpen}
        onToggleFiles={onToggleFiles}
      />
      <WorkspaceTreeDrawer
        kind={filesOpen ? "files" : null}
        onClose={onToggleFiles}
      >
        <p role="status" className="px-4 py-3 text-xs text-zinc-400">
          {reason}
        </p>
      </WorkspaceTreeDrawer>
    </div>
  );
}

type PreviewRead = { client: FilesClient; path: string | null } & (
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; output: string; isBinary: boolean }
);
function FilePreview({
  client,
  workspaceId,
  path,
  filesOpen,
  onToggleFiles,
  tree,
}: {
  client: FilesClient;
  workspaceId: WorkspaceId;
  path: string | null;
  filesOpen: boolean;
  onToggleFiles: () => void;
  tree: ReactNode;
}) {
  const [read, setRead] = useState<PreviewRead>({
    client,
    path,
    status: "loading",
  });
  useEffect(() => {
    let active = true;
    setRead({ client, path, status: "loading" });
    if (path === null)
      return () => {
        active = false;
      };
    void client
      .readWorkspaceFile({ workspaceId, path })
      .then((result) => {
        if (active) setRead({ client, path, status: "ready", ...result });
      })
      .catch((error: unknown) => {
        if (active)
          setRead({
            client,
            path,
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Workspace file could not be read.",
          });
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, path]);
  const currentRead =
    read.client === client && read.path === path ? read : null;
  const ready = currentRead?.status === "ready" ? currentRead : null;
  return (
    <div className="relative h-full min-h-0">
      <WorkspaceContentView
        selectedFile={
          path && ready && !ready.isBinary
            ? { path, content: ready.output }
            : null
        }
        selectedDiff={null}
        pathOverride={path ?? undefined}
        isLoading={
          path !== null && (!currentRead || currentRead.status === "loading")
        }
        error={currentRead?.status === "error" ? currentRead.message : null}
        filesOpen={filesOpen}
        onToggleFiles={onToggleFiles}
        contentOverride={
          ready?.isBinary ? (
            <p role="status" className="p-4 text-sm text-zinc-400">
              Binary file content is not displayed.
            </p>
          ) : undefined
        }
      />
      <WorkspaceTreeDrawer
        kind={filesOpen ? "files" : null}
        onClose={onToggleFiles}
      >
        {tree}
      </WorkspaceTreeDrawer>
    </div>
  );
}
