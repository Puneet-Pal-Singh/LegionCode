import { useId, useState, type KeyboardEvent } from "react";
import type { ThreadSidebarItem } from "@legioncode/sdk";

export interface ThreadSidebarEntry {
  item: ThreadSidebarItem;
  workspaceLabel: string;
}

type WorkspaceSelectionId = string;

export interface ThreadSidebarGroupProps {
  label: string;
  workspaceSelectionId?: WorkspaceSelectionId;
  expanded?: boolean;
  onToggle?: () => void;
  placement?: "local" | "hosted" | null;
  entries: ThreadSidebarEntry[];
  startIndex: number;
  focusedIndex: number;
  rowRefs: Map<string, HTMLButtonElement>;
  pendingArchiveId: string | null;
  onFocus: (index: number) => void;
  onKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    item: ThreadSidebarItem,
  ) => void;
  onSelect: (selectionId: string) => void;
  onArchive?: (selectionId: string) => void | Promise<void>;
  onUnarchive?: (selectionId: string) => void | Promise<void>;
  archived?: boolean;
  onConfirmArchive: (selectionId: string) => Promise<void>;
  onCancelArchive: () => void;
  setPendingArchiveId: (selectionId: string | null) => void;
  onCreate?: () => void;
  onRenameWorkspace?: (
    workspaceSelectionId: WorkspaceSelectionId,
    newLabel: string,
  ) => void | Promise<void>;
  onRemoveWorkspace?: (
    workspaceSelectionId: WorkspaceSelectionId,
  ) => void | Promise<void>;
}

export function ThreadSidebarGroup(
  props: ThreadSidebarGroupProps,
): React.ReactElement {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(props.label);
  const [isConfirmingWorkspaceRemoval, setIsConfirmingWorkspaceRemoval] =
    useState(false);
  const workspaceSelectionId = props.workspaceSelectionId;
  const workspaceContentId = useId();
  const onRenameWorkspace = props.onRenameWorkspace;
  const onRemoveWorkspace = props.onRemoveWorkspace;

  return (
    <section className="lc-thread-sidebar-group" aria-label={props.label}>
      <div className="lc-thread-sidebar-group-heading">
        {props.onToggle && workspaceSelectionId ? (
          <button
            className="lc-thread-sidebar-group-toggle"
            type="button"
            aria-label={`Toggle ${props.label}`}
            aria-expanded={props.expanded}
            aria-controls={workspaceContentId}
            onClick={props.onToggle}
          >
            <span aria-hidden="true">{props.expanded ? "▾" : "▸"}</span>
          </button>
        ) : null}
        {isRenaming && workspaceSelectionId && onRenameWorkspace ? (
          <form
            className="lc-thread-sidebar-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onRenameWorkspace(workspaceSelectionId, draftLabel.trim());
              setIsRenaming(false);
            }}
          >
            <input
              aria-label={`Rename ${props.label}`}
              value={draftLabel}
              autoFocus
              onChange={(event) => setDraftLabel(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setIsRenaming(false);
              }}
            />
            <button type="submit" disabled={!draftLabel.trim()}>
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftLabel(props.label);
                setIsRenaming(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <span>{props.label}</span>
        )}
        {props.placement ? (
          <small>{props.placement === "local" ? "Local only" : "Hosted"}</small>
        ) : null}
        {props.onCreate ? (
          <button
            type="button"
            aria-label={`New thread in ${props.label}`}
            onClick={props.onCreate}
          >
            ＋
          </button>
        ) : null}
        {workspaceSelectionId && onRenameWorkspace ? (
          <button
            type="button"
            aria-label={`Rename workspace ${props.label}`}
            onClick={() => {
              setDraftLabel(props.label);
              setIsRenaming(true);
            }}
          >
            Rename
          </button>
        ) : null}
        {workspaceSelectionId && onRemoveWorkspace ? (
          <button
            type="button"
            aria-label={`Remove workspace ${props.label}`}
            onClick={() => setIsConfirmingWorkspaceRemoval(true)}
          >
            Remove
          </button>
        ) : null}
      </div>
      {isConfirmingWorkspaceRemoval &&
      workspaceSelectionId &&
      onRemoveWorkspace ? (
        <div
          className="lc-thread-sidebar-remove-confirm"
          role="group"
          aria-label={`Confirm removal of ${props.label}`}
        >
          <span>Remove workspace?</span>
          <button
            type="button"
            onClick={() => setIsConfirmingWorkspaceRemoval(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void onRemoveWorkspace(workspaceSelectionId);
              setIsConfirmingWorkspaceRemoval(false);
            }}
          >
            Confirm
          </button>
        </div>
      ) : null}
      <ul
        id={workspaceSelectionId ? workspaceContentId : undefined}
        hidden={props.onToggle ? !props.expanded : undefined}
      >
        {props.entries.map(({ item }, offset) => {
          const index = props.startIndex + offset;
          const confirming = props.pendingArchiveId === item.selectionId;
          return (
            <li className="lc-thread-sidebar-row" key={item.selectionId}>
              <button
                ref={(element) => {
                  if (element) props.rowRefs.set(item.selectionId, element);
                  else props.rowRefs.delete(item.selectionId);
                }}
                id={`thread-${item.selectionId}`}
                type="button"
                role="option"
                aria-selected={item.isSelected}
                aria-label={`${item.title}${item.displayStatus === "waiting_for_approval" ? ", awaiting approval" : ""}`}
                tabIndex={props.focusedIndex === index ? 0 : -1}
                className={`lc-thread-sidebar-thread${item.isSelected ? " lc-thread-sidebar-thread-selected" : ""}`}
                onFocus={() => props.onFocus(index)}
                onKeyDown={(event) => props.onKeyDown(event, index, item)}
                onClick={() => props.onSelect(item.selectionId)}
              >
                <span className="lc-thread-sidebar-thread-title">
                  {item.title}
                </span>
                {item.displayStatus === "waiting_for_approval" ? (
                  <span className="lc-thread-sidebar-status">
                    Awaiting approval
                  </span>
                ) : null}
                {item.displayStatus !== "idle" &&
                item.displayStatus !== "waiting_for_approval" ? (
                  <span
                    className={`lc-thread-sidebar-state lc-thread-sidebar-state-${item.displayStatus}`}
                    aria-label={`Status: ${item.displayStatus.replaceAll("_", " ")}`}
                    title={item.displayStatus.replaceAll("_", " ")}
                  />
                ) : null}
                {item.isUnread ? (
                  <span
                    className="lc-thread-sidebar-unread"
                    aria-label="Unread activity"
                    title="Unread activity"
                  />
                ) : null}
                {item.isPinned ? (
                  <span className="lc-thread-sidebar-pin" aria-label="Pinned">
                    ◆
                  </span>
                ) : null}
              </button>
              {props.archived && props.onUnarchive ? (
                <button
                  className="lc-thread-sidebar-archive"
                  type="button"
                  aria-label={`Unarchive ${item.title}`}
                  onClick={() => {
                    void props.onUnarchive?.(item.selectionId);
                  }}
                >
                  Unarchive
                </button>
              ) : null}
              {!props.archived && props.onArchive ? (
                confirming ? (
                  <span className="lc-thread-sidebar-confirm">
                    <button
                      type="button"
                      aria-label={`Cancel archive for ${item.title}`}
                      onClick={props.onCancelArchive}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      aria-label={`Confirm archive for ${item.title}`}
                      onClick={() => {
                        void props.onConfirmArchive(item.selectionId);
                      }}
                    >
                      Archive
                    </button>
                  </span>
                ) : (
                  <button
                    className="lc-thread-sidebar-archive"
                    type="button"
                    aria-label={`Archive ${item.title}`}
                    onClick={() => props.setPendingArchiveId(item.selectionId)}
                  >
                    Archive
                  </button>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
