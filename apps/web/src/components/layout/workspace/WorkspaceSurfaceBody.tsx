import type { ReactNode } from "react";
import type { SelectedDiff, SelectedFile } from "./useWorkspaceState";
import { WorkspaceContentView } from "./WorkspaceContentView";
import type { SidebarContentTab } from "./useWorkspaceState";
import { ContextDetailsPanel } from "../../chat/context/ContextDetailsPanel";

interface WorkspaceSurfaceBodyProps {
  reviewActive: boolean;
  reviewContent: ReactNode;
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  selectedContext?: Extract<SidebarContentTab, { kind: "context" }> | null;
  isLoadingContent: boolean;
  contentError?: string | null;
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
  selectedContext = null,
  isLoadingContent,
  contentError,
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

  if (selectedContext) {
    return (
      <ContextDetailsPanel
        budget={selectedContext.budget}
        usage={selectedContext.usage}
      />
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <WorkspaceContentView
        selectedFile={selectedFile}
        selectedDiff={selectedDiff}
        isLoading={isLoadingContent}
        error={contentError}
        filesOpen={filesOpen}
        onToggleFiles={onToggleFiles}
        filesRail={filesRail}
        railPlacement={railPlacement}
      />
      {overlay}
    </div>
  );
}
