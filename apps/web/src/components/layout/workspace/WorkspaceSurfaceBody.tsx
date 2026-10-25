import type { ReactNode } from "react";
import type { SelectedDiff, SelectedFile } from "./useWorkspaceState";
import { WorkspaceContentView } from "./WorkspaceContentView";
import type { SidebarContentTab } from "./useWorkspaceState";
import { ChatImageGallery, ContextDetailsPanel } from "@legioncode/client-ui";
import type { SavedChatSourcesProjection } from "../../../lib/saved-chat-sources";

interface WorkspaceSurfaceBodyProps {
  reviewActive: boolean;
  reviewContent: ReactNode;
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  selectedContext?: Extract<SidebarContentTab, { kind: "context" }> | null;
  selectedSources?: boolean;
  savedSources?: SavedChatSourcesProjection;
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
  selectedSources = false,
  savedSources = { images: [], status: "ready", error: null },
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
        session={selectedContext.session}
      />
    );
  }

  if (selectedSources) {
    return (
      <section
        aria-label="Saved sources"
        className="h-full min-h-0 overflow-y-auto bg-[#111113] px-4 py-4"
      >
        <div className="mb-4 border-b border-zinc-800 pb-3">
          <h2 className="text-sm font-semibold text-zinc-100">Sources</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Images saved with messages in this chat
          </p>
        </div>
        {savedSources.status === "loading" ? (
          <p role="status" className="mb-3 text-xs text-zinc-500">
            Loading saved sources…
          </p>
        ) : null}
        {savedSources.status === "partial" ? (
          <p role="status" className="mb-3 text-xs text-amber-300">
            Showing sources from the available chat history. Some history could not be loaded.
          </p>
        ) : null}
        {savedSources.status === "failed" || savedSources.status === "recovery-required" ? (
          <p role="status" className="mb-3 text-xs text-amber-300">
            Saved chat sources could not be fully loaded.
          </p>
        ) : null}
        {savedSources.error ? (
          <p className="mb-3 text-xs text-zinc-500">{savedSources.error}</p>
        ) : null}
        {savedSources.images.length > 0 ? (
          <ChatImageGallery images={savedSources.images} />
        ) : savedSources.status === "ready" ? (
          <p className="text-xs text-zinc-500">
            No saved image sources in this chat.
          </p>
        ) : null}
      </section>
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
