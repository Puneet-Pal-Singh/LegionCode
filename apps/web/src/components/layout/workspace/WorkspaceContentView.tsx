import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ArtifactView } from "../../chat/ArtifactView";
import { DiffViewer } from "../../diff/DiffViewer";
import { FileNavigationBar } from "./FileNavigationBar";
import type { SelectedDiff, SelectedFile } from "./useWorkspaceState";

interface WorkspaceContentViewProps {
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  isLoading: boolean;
  filesOpen: boolean;
  onToggleFiles: () => void;
  onOpenIde?: (ide: string) => void;
  filesRail?: ReactNode;
  railPlacement?: "inline" | "overlay";
}

export function WorkspaceContentView({
  selectedFile,
  selectedDiff,
  isLoading,
  filesOpen,
  onToggleFiles,
  onOpenIde,
  filesRail,
  railPlacement = "overlay",
}: WorkspaceContentViewProps) {
  const [wordWrap, setWordWrap] = useState(true);
  const [richPreviewByPath, setRichPreviewByPath] = useState<
    Record<string, boolean>
  >({});
  const selectedPath = selectedFile?.path ?? selectedDiff?.path ?? "/";
  const markdownPath =
    selectedFile && /\.mdx?$/i.test(selectedFile.path)
      ? selectedFile.path
      : null;
  const richPreview = markdownPath
    ? (richPreviewByPath[markdownPath] ?? true)
    : false;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <FileNavigationBar
        path={selectedPath}
        content={selectedFile?.content}
        filesOpen={filesOpen}
        wordWrap={wordWrap}
        onWordWrapChange={setWordWrap}
        onOpenFiles={onToggleFiles}
        onOpenIde={onOpenIde}
        richPreview={richPreview}
        onRichPreviewChange={
          markdownPath
            ? (enabled) =>
                setRichPreviewByPath((current) => ({
                  ...current,
                  [markdownPath]: enabled,
                }))
            : undefined
        }
      />
      <div className="flex min-h-0 flex-1">
        {filesOpen && railPlacement === "inline" ? (
          <aside className="flex w-72 shrink-0 overflow-hidden border-r border-zinc-800 bg-black">
            {filesRail}
          </aside>
        ) : null}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={24} className="animate-spin text-zinc-600" />
            </div>
          ) : selectedFile ? (
            <ArtifactView
              isOpen
              title={selectedFile.path}
              content={selectedFile.content}
              wordWrap={wordWrap}
              richPreview={richPreview}
            />
          ) : selectedDiff ? (
            <DiffViewer
              diff={selectedDiff.content}
              className="h-full"
              wordWrap={wordWrap}
              onWordWrapChange={setWordWrap}
              showHeader={false}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
