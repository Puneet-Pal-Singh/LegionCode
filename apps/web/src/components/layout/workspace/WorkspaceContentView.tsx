import { AlertCircle, Folders, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ArtifactView } from "../../chat/ArtifactView";
import { DiffViewer } from "../../diff/DiffViewer";
import { FileNavigationBar } from "./FileNavigationBar";
import { ResizableWorkspaceRail } from "./ResizableWorkspaceRail";
import type { SelectedDiff, SelectedFile } from "./useWorkspaceState";

interface WorkspaceContentViewProps {
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  isLoading: boolean;
  error?: string | null;
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
  error,
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
        <div className="min-w-0 flex-1 overflow-y-auto bg-[#111113]">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={24} className="animate-spin text-zinc-600" />
            </div>
          ) : error ? (
            <FileLoadError message={error} />
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
          ) : (
            <EmptyFilePreview />
          )}
        </div>
        {filesOpen && railPlacement === "inline" ? (
          <ResizableWorkspaceRail placement="right" className="bg-[#111113]">
            {filesRail}
          </ResizableWorkspaceRail>
        ) : null}
      </div>
    </div>
  );
}

function FileLoadError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertCircle size={32} className="text-rose-400" />
      <p className="text-sm font-semibold text-zinc-100">Unable to open file</p>
      <p className="max-w-sm text-xs text-zinc-500">{message}</p>
    </div>
  );
}

function EmptyFilePreview() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Folders size={38} className="text-zinc-500" />
      <p className="text-sm font-semibold text-zinc-100">Open file</p>
      <p className="text-xs text-zinc-500">
        Select a file from the workspace tree
      </p>
    </div>
  );
}
