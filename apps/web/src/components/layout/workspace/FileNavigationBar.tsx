import {
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  Folder,
  Image,
  WrapText,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useOutsideDismiss } from "../../../hooks/useOutsideDismiss";

interface FileNavigationBarProps {
  path: string;
  wordWrap: boolean;
  onWordWrapChange: (enabled: boolean) => void;
  onOpenFiles: () => void;
  content?: string;
  filesOpen: boolean;
  richPreview?: boolean;
  onRichPreviewChange?: (enabled: boolean) => void;
}

export function FileNavigationBar({
  path,
  wordWrap,
  onWordWrapChange,
  onOpenFiles,
  content,
  filesOpen,
  richPreview,
  onRichPreviewChange,
}: FileNavigationBarProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setIsMenuOpen(false), []);
  useOutsideDismiss(menuRef, isMenuOpen, closeMenu);
  const segments = path.split("/").filter(Boolean);

  const copyPath = async () => {
    await navigator.clipboard.writeText(path);
    setPathCopied(true);
    setIsMenuOpen(false);
  };

  const copyContent = async () => {
    await navigator.clipboard.writeText(content ?? "");
    setIsMenuOpen(false);
  };

  return (
    <div
      ref={menuRef}
      className="relative z-40 flex h-10 shrink-0 items-center border-b border-zinc-800 bg-[#111113] px-2"
    >
      <div className="flex min-w-0 flex-1 items-center overflow-hidden text-xs text-zinc-500">
        {segments.length === 0 ? (
          <span className="px-1 text-zinc-300">/</span>
        ) : null}
        {segments.map((segment, index) => (
          <div
            key={`${segment}:${index}`}
            className="flex min-w-0 items-center"
          >
            {index > 0 ? (
              <ChevronRight size={13} className="mx-0.5 shrink-0" />
            ) : null}
            <span
              className={
                index === segments.length - 1
                  ? "truncate text-zinc-200"
                  : "truncate"
              }
            >
              {segment}
            </span>
          </div>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setIsMenuOpen((previous) => !previous)}
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="File options"
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
        >
          <Ellipsis size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenFiles}
          className="rounded-lg bg-zinc-900 p-2 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
          aria-label="Toggle files"
          aria-pressed={filesOpen}
          title={filesOpen ? "Hide files" : "Show files"}
        >
          <Folder size={17} />
        </button>
      </div>

      {isMenuOpen ? (
        <div
          role="menu"
          className="absolute right-10 top-9 z-50 min-w-48 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyPath()}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-900"
          >
            {pathCopied ? <Check size={14} /> : <Folder size={14} />}
            Copy path
          </button>
          {content !== undefined ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => void copyContent()}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-900"
            >
              <Copy size={14} />
              Copy file contents
            </button>
          ) : null}
          {onRichPreviewChange ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onRichPreviewChange(!richPreview);
                setIsMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-900"
            >
              <Image size={14} />
              {richPreview ? "Disable rich preview" : "Enable rich preview"}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onWordWrapChange(!wordWrap);
              setIsMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-900"
          >
            <WrapText size={14} />
            {wordWrap ? "Disable word wrap" : "Enable word wrap"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
