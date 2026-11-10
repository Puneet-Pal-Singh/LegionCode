import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import {
  Resizer,
  ReviewDialogFrame,
  ReviewDialogCloseButton,
  WorkspaceSurfaceHeader,
  WorkspaceSidebarHeader,
} from "@legioncode/client-ui";
import type { LocalWorkspaceGrant, ThreadId } from "@repo/platform-protocol";
import type { DesktopReviewSelection } from "./DesktopReview";

export interface DesktopRightPanelControls {
  isReviewVisible?: boolean;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  isChangesOpen: boolean;
  onToggleChanges: () => void;
  isFilesOpen: boolean;
  onToggleFiles: () => void;
}

export interface DesktopRightPanelReview {
  scope: Pick<
    LocalWorkspaceGrant,
    "workspaceId" | "grantedAt" | "readiness"
  > & { threadId: ThreadId | null };
  selection: DesktopReviewSelection | null;
  /** Main supplies explicit saved Turn and live workspace SDK adapters. */
  content: (controls: DesktopRightPanelControls) => ReactNode;
}

export interface DesktopRightPanelProps {
  workspace: Pick<
    LocalWorkspaceGrant,
    "workspaceId" | "displayName" | "readiness" | "grantedAt"
  > | null;
  threadId: ThreadId | null;
  review: DesktopRightPanelReview | null;
  files?: Pick<
    LocalWorkspaceGrant,
    "workspaceId" | "grantedAt" | "readiness"
  > & {
    content: (controls: DesktopRightPanelControls) => ReactNode;
  };
  filesUnavailableReason: string;
  onClose?: () => void;
  onResize?: (delta: number) => void;
  headerWidth?: number;
  changesRequestId?: number;
}

// Match the shared frame's full-width right-panel breakpoint.
const COMPACT_RIGHT_PANEL_QUERY = "(max-width: 767px)";

/** Shared Web presentation; grant identity and all reads stay in Desktop's SDK adapters. */
export function DesktopRightPanel({
  workspace,
  threadId,
  review,
  files,
  filesUnavailableReason,
  onClose,
  onResize,
  headerWidth,
  changesRequestId = 0,
}: DesktopRightPanelProps) {
  const [isCompact, setIsCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia(COMPACT_RIGHT_PANEL_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(COMPACT_RIGHT_PANEL_QUERY);
    const update = (event: MediaQueryListEvent): void => setIsCompact(event.matches);
    setIsCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [isViewingContent, setIsViewingContent] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasFilesTab, setHasFilesTab] = useState(false);
  const [isFilesOpen, setIsFilesOpen] = useState(true);
  const [isChangesOpen, setIsChangesOpen] = useState(false);
  useEffect(() => {
    if (changesRequestId === 0) return;
    setIsViewingContent(false);
    setIsChangesOpen(true);
  }, [changesRequestId]);
  const fileScope = JSON.stringify([
    workspace?.workspaceId,
    workspace?.grantedAt,
    workspace?.readiness,
  ]);
  const [fileSelection, setFileSelection] = useState<{
    scope: string;
    path: string;
  } | null>(null);
  const selectedPath =
    fileSelection?.scope === fileScope ? fileSelection.path : null;
  useLayoutEffect(() => {
    setFileSelection(null);
  }, [fileScope]);
  useEffect(() => {
    setIsExpanded(false);
  }, [fileScope, threadId]);
  const workspaceReady = workspace?.readiness === "ready";
  const matchingReview =
    workspaceReady &&
    review &&
    review.scope.workspaceId === workspace.workspaceId &&
    review.scope.threadId === threadId &&
    review.scope.grantedAt === workspace.grantedAt &&
    review.scope.readiness === workspace.readiness &&
    (!review.selection ||
      (review.selection.workspaceId === workspace.workspaceId &&
        review.selection.threadId === threadId))
      ? review
      : null;
  const matchingFiles =
    workspaceReady &&
    files &&
    files.workspaceId === workspace.workspaceId &&
    files.grantedAt === workspace.grantedAt &&
    files.readiness === workspace.readiness
      ? files
      : null;

  useEffect(() => {
    if (matchingReview?.selection) setIsViewingContent(false);
  }, [matchingReview?.selection]);

  const controls: DesktopRightPanelControls = {
    isReviewVisible: !isViewingContent,
    selectedPath,
    onSelectFile: (path) => {
      setFileSelection({ scope: fileScope, path });
      setHasFilesTab(true);
      setIsViewingContent(true);
    },
    isChangesOpen,
    onToggleChanges: () => setIsChangesOpen((open) => !open),
    isFilesOpen: isViewingContent && isFilesOpen,
    onToggleFiles: () => {
      setHasFilesTab(true);
      setIsViewingContent(true);
      setIsFilesOpen((open) => (isViewingContent ? !open : true));
    },
  };
  const openFiles = () => {
    setHasFilesTab(true);
    setIsViewingContent(true);
    setIsFilesOpen(true);
  };

  const contentTabs = hasFilesTab
    ? [
        {
          id: "files",
          kind: selectedPath ? ("file" as const) : ("empty" as const),
          path: selectedPath ?? "Open file",
        },
      ]
    : [];
  const headerActions = {
    contentTabs,
    activeContentTabId: isViewingContent ? "files" : null,
    onSelectReview: () => setIsViewingContent(false),
    onSelectContent: (_id: string) => setIsViewingContent(true),
    onCloseContent: (_id: string) => {
      setFileSelection(null);
      setHasFilesTab(false);
      setIsViewingContent(false);
      setIsFilesOpen(false);
    },
    onOpenFiles: openFiles,
    onOpenChanges: () => {
      setIsViewingContent(false);
      setIsChangesOpen(true);
    },
  };
  const content = (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        hidden={!isViewingContent}
        className="relative h-full min-h-0 flex-1 overflow-hidden"
      >
        {matchingFiles ? (
          <div
            className="h-full min-h-0"
            key={`${matchingFiles.workspaceId}:${matchingFiles.grantedAt}:${matchingFiles.readiness}`}
          >
            {matchingFiles.content(controls)}
          </div>
        ) : (
          <p role="status" className="p-4 text-sm text-zinc-400">
            {!workspace
              ? "Choose a folder and grant workspace access to browse files."
              : !workspaceReady
                ? "Restore workspace access to browse files."
                : `Workspace file browsing unavailable: ${filesUnavailableReason}`}
          </p>
        )}
      </div>
      <div
        hidden={isViewingContent}
        className="relative h-full min-h-0 flex-1 overflow-hidden"
      >
        {!workspace ? (
          <p role="status" className="p-4 text-sm text-zinc-400">
            Choose a folder and grant workspace access to review saved changes.
          </p>
        ) : !workspaceReady ? (
          <p role="status" className="p-4 text-sm text-zinc-400">
            Restore workspace access to review saved changes.
          </p>
        ) : !matchingReview ? (
          <p role="status" className="p-4 text-sm text-zinc-400">
            Select a settled turn in this thread to review its saved changes.
          </p>
        ) : (
          <div
            className="h-full min-h-0"
            key={`${matchingReview.scope.workspaceId}:${matchingReview.scope.grantedAt}:${matchingReview.scope.readiness}:${matchingReview.scope.threadId}`}
          >
            {matchingReview.content(controls)}
          </div>
        )}
      </div>
    </div>
  );
  return (
    <>
      {/* Keep pane chrome above the topbar and below app dialogs; expanded review is a sibling. */}
      <aside
        aria-label="Workspace files and review"
        className="relative isolate z-30 flex h-full min-h-0 min-w-0 flex-col border-l border-zinc-800 bg-[#111113] text-zinc-200"
      >
        {onResize ? <Resizer side="right" onResize={onResize} /> : null}
        <WorkspaceSidebarHeader
          {...headerActions}
          isViewingContent={isViewingContent}
          position={isCompact ? "inline" : "fixed"}
          sidebarWidth={isCompact ? "100%" : headerWidth}
          onCloseReview={onClose}
          onCloseSidebar={onClose}
          onExpand={() => setIsExpanded(true)}
        />
        {isExpanded ? null : content}
      </aside>
      {isExpanded ? (
        <ReviewDialogFrame isOpen onClose={() => setIsExpanded(false)}>
          {({ titleId, closeButtonRef }) => (
            <>
              <WorkspaceSurfaceHeader
                {...headerActions}
                variant="fullscreen"
                id={titleId}
                ariaLabel="Review workspace tabs"
                reviewActive={!isViewingContent}
                addTabLabel="Files"
                trailingActions={
                  <ReviewDialogCloseButton
                    buttonRef={closeButtonRef}
                    onClose={() => setIsExpanded(false)}
                  />
                }
              />
              {content}
            </>
          )}
        </ReviewDialogFrame>
      ) : null}
    </>
  );
}
