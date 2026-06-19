import { Folders } from "lucide-react";
import { OpenDropdown } from "../../navigation/OpenDropdown";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { FileOptionsMenu } from "./FileOptionsMenu";

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
    <div className="relative z-40 flex h-10 shrink-0 items-center border-b border-zinc-800 bg-[#111113] px-2">
      <FileBreadcrumbs path={path} />

      <div className="flex shrink-0 items-center gap-1">
        <FileOptionsMenu
          path={path}
          content={content}
          wordWrap={wordWrap}
          richPreview={richPreview}
          onWordWrapChange={onWordWrapChange}
          onRichPreviewChange={onRichPreviewChange}
        />
        <OpenDropdown onSelect={onOpenIde} />
        <button
          type="button"
          onClick={onOpenFiles}
          className="rounded-lg bg-zinc-900 p-2 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
          aria-label="Toggle files"
          aria-pressed={filesOpen}
          title={filesOpen ? "Hide files" : "Show files"}
        >
          <Folders size={19} />
        </button>
      </div>
    </div>
  );
}
