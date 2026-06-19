import type { ReactNode } from "react";
import type { SelectedDiff, SelectedFile } from "./useWorkspaceState";
import { WorkspaceContentView } from "./WorkspaceContentView";

interface WorkspaceSurfaceBodyProps {
  reviewActive: boolean;
  reviewContent: ReactNode;
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  isLoadingContent: boolean;
  filesOpen: boolean;
  onToggleFiles: () => void;
  filesRail?: ReactNode;
  railPlacement?: "inline" | "overlay";
  overlay?: ReactNode;
}

export function WorkspaceSurfaceBody({
  reviewActive,
  reviewContent,
  selectedFile,
  selectedDiff,
  isLoadingContent,
  filesOpen,
  onToggleFiles,
  filesRail,
  railPlacement = "overlay",
  overlay,
}: WorkspaceSurfaceBodyProps) {
  if (reviewActive) {
    return (
      <>
        {reviewContent}
        {overlay}
      </>
    );
  }

  return (
    <div className="relative flex h-full min-h-0">
      {filesOpen && railPlacement === "inline" ? (
        <aside className="flex w-72 shrink-0 overflow-hidden border-r border-zinc-800 bg-black">
          {filesRail}
        </aside>
      ) : null}
      <div className="min-w-0 flex-1">
        <WorkspaceContentView
          selectedFile={selectedFile}
          selectedDiff={selectedDiff}
          isLoading={isLoadingContent}
          filesOpen={filesOpen}
          onToggleFiles={onToggleFiles}
        />
      </div>
      {overlay}
    </div>
  );
}
