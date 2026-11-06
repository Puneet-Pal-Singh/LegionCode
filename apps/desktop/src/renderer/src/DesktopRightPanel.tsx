import { useId, useState, type ReactNode } from "react";
import type { LocalWorkspaceGrant, ThreadId, TurnId, WorkspaceId } from "@repo/platform-protocol";

export interface DesktopRightPanelReview {
  selection: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId };
  /** Render DesktopReview here with the same canonical selection and SDK client. */
  content: ReactNode;
}

export interface DesktopRightPanelProps {
  workspace: Pick<LocalWorkspaceGrant, "workspaceId" | "displayName" | "readiness"> | null;
  threadId: ThreadId | null;
  review: DesktopRightPanelReview | null;
  files?: { workspaceId: WorkspaceId; content: ReactNode };
  filesUnavailableReason: string;
  commitUnavailableReason: string;
  onClose?: () => void;
}

/** Presentation slots only: SDK reads remain with DesktopReview and the file-read binding. */
export function DesktopRightPanel({
  workspace,
  threadId,
  review,
  files,
  filesUnavailableReason,
  commitUnavailableReason,
  onClose,
}: DesktopRightPanelProps) {
  const id = useId();
  const [tab, setTab] = useState<"files" | "review">("review");
  const workspaceReady = workspace?.readiness === "ready";
  const matchingReview = workspaceReady && review
    && review.selection.workspaceId === workspace.workspaceId
    && review.selection.threadId === threadId
    ? review : null;

  return (
    <aside aria-label="Workspace files and review" className="flex h-full min-h-0 min-w-0 flex-col border-l border-zinc-800 bg-black text-zinc-200">
      <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Files and review</h2>
          <p className="truncate text-xs text-zinc-500">{workspace?.displayName ?? "No workspace selected"}</p>
        </div>
        {onClose ? <button type="button" onClick={onClose} aria-label="Close files and review" className="rounded px-2 py-1 text-sm hover:bg-zinc-900">Close</button> : null}
      </header>
      <div role="tablist" aria-label="File source" className="flex gap-1 border-b border-zinc-800 p-2">
        {(["files", "review"] as const).map((value) => (
          <button
            key={value}
            id={`${id}-${value}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "files" : event.key === "End" ? "review"
                : value === "files" ? "review" : "files";
              setTab(next);
              document.getElementById(`${id}-${next}-tab`)?.focus();
            }}
            aria-controls={`${id}-${value}-panel`}
            onClick={() => setTab(value)}
            className={`rounded px-3 py-2 text-sm ${tab === value ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}
          >
            {value === "files" ? "Workspace files" : "Saved turn review"}
          </button>
        ))}
      </div>
      <section id={`${id}-files-panel`} role="tabpanel" aria-labelledby={`${id}-files-tab`} hidden={tab !== "files"} className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-3 text-xs text-zinc-500">Current workspace files are separate from saved turn changes.</p>
        {workspaceReady && files && files.workspaceId === workspace.workspaceId ? (
          <div key={files.workspaceId}>{files.content}</div>
        ) : (
          <p role="status" className="text-sm text-zinc-400">
            {!workspace ? "Choose a folder and grant workspace access to browse files."
              : !workspaceReady ? "Restore workspace access to browse files."
              : `Workspace file browsing unavailable: ${filesUnavailableReason}`}
          </p>
        )}
      </section>
      <section id={`${id}-review-panel`} role="tabpanel" aria-labelledby={`${id}-review-tab`} hidden={tab !== "review"} className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-3 text-xs text-zinc-500">Saved turn changes stay tied to the selected completed turn.</p>
        {!workspace ? <p role="status">Choose a folder and grant workspace access to review saved changes.</p>
          : !workspaceReady ? <p role="status">Restore workspace access to review saved changes.</p>
          : !threadId ? <p role="status">Open a thread to select a completed turn.</p>
          : !matchingReview ? <p role="status">Select a completed turn in this thread to review its saved changes.</p>
          : <div key={`${matchingReview.selection.workspaceId}:${matchingReview.selection.threadId}:${matchingReview.selection.turnId}`}>{matchingReview.content}</div>}
      </section>
      <footer className="border-t border-zinc-800 p-4">
        <button type="button" disabled aria-describedby={`${id}-commit-reason`} className="w-full rounded border border-zinc-800 px-3 py-2 text-sm text-zinc-500 disabled:cursor-not-allowed">Commit saved changes</button>
        <p id={`${id}-commit-reason`} className="mt-2 text-xs text-zinc-500">{commitUnavailableReason}</p>
      </footer>
    </aside>
  );
}
