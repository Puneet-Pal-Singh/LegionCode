import { Archive, MoreHorizontal, Pencil, Pin, PinOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentSession } from "../../types/session";

interface ChatHeaderMenuProps {
  session: AgentSession | null;
  onRename: (title: string) => Promise<void>;
  onPin: () => Promise<void>;
  onUnpin: () => Promise<void>;
  onArchive: () => Promise<void>;
}

export function ChatHeaderMenu({
  session,
  onRename,
  onPin,
  onUnpin,
  onArchive,
}: ChatHeaderMenuProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session?.name ?? "");
  const menuRef = useRef<HTMLDivElement>(null);
  const isDisabled = !session;

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent): void {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsOpen(false);
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const saveRename = async (): Promise<void> => {
    const trimmedTitle = renameValue.trim();
    if (!trimmedTitle || !session) {
      return;
    }
    await onRename(trimmedTitle.slice(0, 80));
    setIsRenaming(false);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-label="Chat actions"
        title="Chat actions"
        disabled={isDisabled}
        onClick={() => setIsOpen((value) => !value)}
        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>

      {isOpen && session ? (
        <div
          role="menu"
          className="ui-surface-popover absolute left-0 top-8 z-[70] w-56 p-1.5"
        >
          <MenuButton
            icon={session.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}
            label={session.pinnedAt ? "Unpin chat" : "Pin chat"}
            onClick={async () => {
              await (session.pinnedAt ? onUnpin() : onPin());
              setIsOpen(false);
            }}
          />
          <MenuButton
            icon={<Pencil size={15} />}
            label="Rename chat"
            onClick={() => {
              setRenameValue(session.name);
              setIsRenaming(true);
            }}
          />
          <MenuButton
            icon={<Archive size={15} />}
            label="Archive chat"
            onClick={async () => {
              await onArchive();
              setIsOpen(false);
            }}
          />
        </div>
      ) : null}

      {isRenaming && session ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
          <form
            className="ui-surface-modal w-full max-w-sm p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveRename();
            }}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">
                Rename chat
              </h2>
              <button
                type="button"
                aria-label="Cancel rename"
                onClick={() => setIsRenaming(false)}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <X size={15} />
              </button>
            </div>
            <input
              autoFocus
              value={renameValue}
              maxLength={80}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setIsRenaming(false);
                }
              }}
              className="ui-input h-9 w-full px-3 text-sm text-zinc-100"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsRenaming(false)}
                className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={renameValue.trim().length === 0}
                className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void | Promise<void>;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => void onClick()}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
    >
      <span className="text-zinc-400">{icon}</span>
      {label}
    </button>
  );
}
