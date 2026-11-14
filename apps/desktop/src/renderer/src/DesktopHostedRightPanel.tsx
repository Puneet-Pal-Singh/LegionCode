import { useEffect, useRef, useState } from "react";
import {
  Resizer,
  ReviewDialogCloseButton,
  ReviewDialogFrame,
  WorkspaceSidebarHeader,
  WorkspaceSurfaceHeader,
} from "@legioncode/client-ui";
import type { DiffContent } from "@repo/shared-types";
import type { DesktopHostedReviewTurn } from "./DesktopHostedConversation";
import type { DesktopRightPanelControls } from "./DesktopRightPanel";
import { DesktopReviewPresentation } from "./DesktopReviewPresentation";

export interface DesktopHostedRightPanelProps {
  readonly review: DesktopHostedReviewTurn | null;
  readonly onClose: () => void;
  readonly onResize?: (delta: number) => void;
  readonly width?: number;
  readonly active?: boolean;
}
type FileRead = {
  readonly review: DesktopHostedReviewTurn;
  readonly path: string;
  readonly status: "loading" | "ready" | "error";
  readonly diff: DiffContent | null;
};

/** Saved captured review only. No checkout, local grant or Git mutation authority. */
export function DesktopHostedRightPanel({
  review, onClose, onResize, width, active = true,
}: DesktopHostedRightPanelProps) {
  const [isCompact, setIsCompact] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setIsCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [expanded, setExpanded] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const [selection, setSelection] = useState<{ review: DesktopHostedReviewTurn; path: string } | null>(null);
  const selectedFile = review?.files.find((file) => selection?.review === review && file.path === selection.path)
    ?? review?.files[0] ?? null;
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<FileRead | null>(null);
  const current = useRef({ review, active, path: selectedFile?.path ?? null, onClose, onResize });
  current.current = { review, active, path: selectedFile?.path ?? null, onClose, onResize };
  useEffect(() => { setExpanded(false); }, [review, active]);
  useEffect(() => {
    if (!active || !review || review.error || !selectedFile) return;
    const captured = { review, path: selectedFile.path };
    let reading = true;
    const isCurrent = () => reading && current.current.active && current.current.review === captured.review &&
      current.current.path === captured.path;
    setRead({ ...captured, status: "loading", diff: null });
    void review.loadFileDiff(selectedFile).then((diff) => {
      if (isCurrent()) setRead({ ...captured, status: "ready", diff });
    }).catch(() => {
      if (isCurrent()) setRead({ ...captured, status: "error", diff: null });
    });
    return () => { reading = false; };
  }, [active, review, selectedFile, revision]);

  if (!active) return null;
  const result = read?.review === review && read.path === selectedFile?.path ? read : null;
  const message = !review ? "Select a settled reply to review its saved changes."
    : review.error ?? (review.files.length === 0 ? "No saved changes in this reply."
      : !result || result.status === "loading" ? "Loading saved file diff…"
        : result.status === "error" ? "The saved file diff could not be loaded." : undefined);
  const selectPath = (path: string) => {
    const source = current.current;
    if (!source.active || !source.review?.files.some((file) => file.path === path)) return;
    setSelection({ review: source.review, path });
  };
  // Files here means the immutable file list of this captured reply, never the live checkout.
  const openCapturedFiles = () => { if (current.current.active) setChangesOpen(true); };
  const close = () => { if (current.current.active) current.current.onClose(); };
  const controls: DesktopRightPanelControls = {
    isReviewVisible: true,
    selectedPath: selectedFile?.path ?? null,
    onSelectFile: selectPath,
    isChangesOpen: changesOpen,
    onToggleChanges: () => setChangesOpen((open) => !open),
    isFilesOpen: changesOpen,
    onToggleFiles: () => setChangesOpen((open) => !open),
  };
  const header = {
    contentTabs: [], activeContentTabId: null,
    onSelectReview: openCapturedFiles,
    onSelectContent: openCapturedFiles,
    onCloseContent: () => setChangesOpen(false),
    onOpenFiles: openCapturedFiles,
    onOpenChanges: openCapturedFiles,
  };
  const content = <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
    <DesktopReviewPresentation
      controls={controls}
      canonicalTurn={review !== null}
      files={review?.files ?? []}
      selectedFile={selectedFile}
      onSelectFile={(file) => selectPath(file.path)}
      diff={result?.status === "ready" ? result.diff : null}
      message={message}
      error={Boolean(review?.error || result?.status === "error")}
      onRetry={result?.status === "error" ? () => setRevision((value) => value + 1) : undefined}
      emptyLabel="No saved changes in this reply."
    />
  </div>;
  return <>
    <aside aria-label="Saved cloud turn review"
      className="relative isolate z-30 flex h-full min-h-0 min-w-0 flex-col border-l border-zinc-800 bg-[#111113] text-zinc-200">
      {onResize ? <Resizer side="right" onResize={(delta) => {
        if (current.current.active) current.current.onResize?.(delta);
      }} /> : null}
      <WorkspaceSidebarHeader {...header}
        sidebarWidth={isCompact ? "100%" : width}
        position={isCompact ? "inline" : "fixed"}
        isViewingContent={false}
        onCloseReview={close}
        onCloseSidebar={close}
        onExpand={() => setExpanded(true)}
      />
      {expanded ? null : content}
    </aside>
    <ReviewDialogFrame isOpen={expanded} onClose={() => setExpanded(false)}>
      {({ titleId, closeButtonRef }) => <>
        <WorkspaceSurfaceHeader {...header}
          variant="fullscreen" id={titleId} ariaLabel="Saved cloud review tabs"
          reviewActive addTabLabel="Saved reply files"
          trailingActions={<ReviewDialogCloseButton buttonRef={closeButtonRef} onClose={() => setExpanded(false)} />}
        />
        {content}
      </>}
    </ReviewDialogFrame>
  </>;
}
