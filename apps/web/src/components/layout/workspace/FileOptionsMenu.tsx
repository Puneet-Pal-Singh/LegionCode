import {
  Check,
  Copy,
  Ellipsis,
  Folder,
  Image,
  WrapText,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useOutsideDismiss } from "../../../hooks/useOutsideDismiss";

interface FileOptionsMenuProps {
  path: string;
  content?: string;
  wordWrap: boolean;
  richPreview?: boolean;
  onWordWrapChange: (enabled: boolean) => void;
  onRichPreviewChange?: (enabled: boolean) => void;
}

export function FileOptionsMenu(props: FileOptionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useOutsideDismiss(menuRef, isOpen, close);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        aria-label="File options"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <Ellipsis size={16} />
      </button>
      {isOpen ? (
        <FileOptionsMenuItems
          {...props}
          pathCopied={pathCopied}
          onPathCopied={() => setPathCopied(true)}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

interface FileOptionsMenuItemsProps extends FileOptionsMenuProps {
  pathCopied: boolean;
  onPathCopied: () => void;
  onClose: () => void;
}

function FileOptionsMenuItems({
  path,
  content,
  wordWrap,
  richPreview,
  onWordWrapChange,
  onRichPreviewChange,
  pathCopied,
  onPathCopied,
  onClose,
}: FileOptionsMenuItemsProps) {
  const copy = async (value: string, afterCopy?: () => void) => {
    try {
      await navigator.clipboard.writeText(value);
      afterCopy?.();
    } catch (error) {
      console.error("[file-options-menu/copy] Failed to copy:", error);
    } finally {
      onClose();
    }
  };

  return (
    <div
      role="menu"
      className="absolute right-0 top-9 z-50 min-w-48 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl"
    >
      <FileOption
        label="Copy path"
        icon={pathCopied ? Check : Folder}
        onClick={() => void copy(path, onPathCopied)}
      />
      {content !== undefined ? (
        <FileOption
          label="Copy file contents"
          icon={Copy}
          onClick={() => void copy(content)}
        />
      ) : null}
      {onRichPreviewChange ? (
        <FileOption
          label={richPreview ? "Disable rich preview" : "Enable rich preview"}
          icon={Image}
          onClick={() => {
            onRichPreviewChange(!richPreview);
            onClose();
          }}
        />
      ) : null}
      <FileOption
        label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
        icon={WrapText}
        onClick={() => {
          onWordWrapChange(!wordWrap);
          onClose();
        }}
      />
    </div>
  );
}

function FileOption({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-900"
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
