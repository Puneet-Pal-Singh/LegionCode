import type { ReactNode } from "react";
import { ResizableWorkspaceRail } from "../workspace/ResizableWorkspaceRail.js";

/** The Web ChangesPanel body; reads and review authority remain in client ports. */
export function ReviewPanelLayout({
  className = "",
  mode = "sidebar",
  layout = "side-by-side",
  isChangesOpen = false,
  isFilesOpen = false,
  showChangesRail = true,
  canonicalTurn = false,
  toolbar,
  changesList,
  filesRail,
  children,
}: {
  className?: string;
  mode?: "sidebar" | "modal";
  layout?: "side-by-side" | "stacked";
  isChangesOpen?: boolean;
  isFilesOpen?: boolean;
  showChangesRail?: boolean;
  canonicalTurn?: boolean;
  toolbar?: ReactNode;
  changesList?: ReactNode;
  filesRail?: ReactNode;
  children: ReactNode;
}) {
  const showStackedReview = layout === "stacked";
  const showChangesList =
    showChangesRail &&
    (!showStackedReview || (mode === "modal" && isChangesOpen));
  return (
    <div
      data-testid={canonicalTurn ? "canonical-turn-review-sidebar" : undefined}
      className={`flex h-full min-h-0 flex-col overflow-visible bg-transparent ${
        mode === "modal"
          ? "p-0"
          : showStackedReview
            ? "gap-4 py-4"
            : "gap-4 p-4"
      } ${className}`}
    >
      {toolbar}
      <div
        className={`flex min-h-0 flex-1 overflow-hidden ${
          mode === "sidebar" ||
          (mode === "modal" && layout === "stacked" && !isChangesOpen)
            ? isFilesOpen
              ? ""
              : "flex-col gap-3"
            : ""
        }`}
      >
        {mode === "modal" && isFilesOpen ? (
          <ResizableWorkspaceRail placement="left">
            {filesRail}
          </ResizableWorkspaceRail>
        ) : null}
        {showChangesList ? (
          mode === "modal" ? (
            <ResizableWorkspaceRail placement="left">
              {changesList}
            </ResizableWorkspaceRail>
          ) : (
            <div className="ui-surface-section flex max-h-56 w-full shrink-0 flex-col overflow-y-auto scrollbar-hide">
              {changesList}
            </div>
          )
        ) : null}
        {children}
      </div>
    </div>
  );
}
