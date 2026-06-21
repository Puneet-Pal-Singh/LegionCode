import { Folders, Plus } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useOutsideDismiss } from "../../../hooks/useOutsideDismiss";
import { cn } from "../../../lib/utils";
import { FileChangesIcon } from "../../sidebar/FileChangesIcon";

interface WorkspaceAddMenuProps {
  onOpenFiles: () => void;
  onOpenChanges: () => void;
  align?: "left" | "right";
  triggerClassName?: string;
  triggerLabel?: string;
}

export function WorkspaceAddMenu({
  onOpenFiles,
  onOpenChanges,
  align = "left",
  triggerClassName,
  triggerLabel = "Files",
}: WorkspaceAddMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(rootRef, open, close);
  const runAndClose = (action: () => void) => () => {
    action();
    close();
  };

  return (
    <div ref={rootRef} className="group relative ml-1 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white",
          triggerClassName,
        )}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={17} />
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-[90] mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300 opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {triggerLabel}
      </span>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-full z-[90] mt-1.5 w-44 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl",
            align === "left" ? "left-0" : "right-0",
          )}
        >
          <MenuItem
            label="Files"
            icon={<Folders size={16} />}
            onClick={runAndClose(onOpenFiles)}
          />
          <MenuItem
            label="File changes"
            icon={<FileChangesIcon size={16} />}
            onClick={runAndClose(onOpenChanges)}
          />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-white"
    >
      {icon}
      {label}
    </button>
  );
}
