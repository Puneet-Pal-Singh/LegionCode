import type { ReactNode } from "react";
import { FileBreadcrumbs } from "./FileBreadcrumbs.js";
import { FileOptionsMenu } from "./FileOptionsMenu.js";
import { FilesToggleButton } from "./FilesToggleButton.js";

interface FileNavigationBarProps {
  path: string;
  wordWrap: boolean;
  onWordWrapChange: (enabled: boolean) => void;
  onOpenFiles: () => void;
  content?: string;
  filesOpen: boolean;
  richPreview?: boolean;
  onRichPreviewChange?: (enabled: boolean) => void;
  openActions?: ReactNode;
}

export function WorkspaceFileNavigationBar({
  path,
  wordWrap,
  onWordWrapChange,
  onOpenFiles,
  content,
  filesOpen,
  richPreview,
  onRichPreviewChange,
  openActions,
}: FileNavigationBarProps) {
  return (
    <div className="relative z-40 flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-black px-4 py-3">
      <FileBreadcrumbs path={path} />

      <div className="flex shrink-0 items-center gap-2">
        <FileOptionsMenu
          path={path}
          content={content}
          wordWrap={wordWrap}
          richPreview={richPreview}
          onWordWrapChange={onWordWrapChange}
          onRichPreviewChange={onRichPreviewChange}
        />
        {openActions}
        <FilesToggleButton isOpen={filesOpen} onToggle={onOpenFiles} />
      </div>
    </div>
  );
}
