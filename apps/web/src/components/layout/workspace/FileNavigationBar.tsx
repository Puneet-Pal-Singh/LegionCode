import { OpenDropdown } from "../../navigation/OpenDropdown";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { FileOptionsMenu } from "./FileOptionsMenu";
import { FilesToggleButton } from "./FilesToggleButton";

interface FileNavigationBarProps {
  path: string;
  wordWrap: boolean;
  onWordWrapChange: (enabled: boolean) => void;
  onOpenFiles: () => void;
  content?: string;
  filesOpen: boolean;
  richPreview?: boolean;
  onRichPreviewChange?: (enabled: boolean) => void;
  onOpenIde?: (ide: string) => void;
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
  onOpenIde,
}: FileNavigationBarProps) {
  return (
    <div className="relative z-40 flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-[#111113] px-4 py-3">
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
        <OpenDropdown onSelect={onOpenIde} />
        <FilesToggleButton isOpen={filesOpen} onToggle={onOpenFiles} />
      </div>
    </div>
  );
}
