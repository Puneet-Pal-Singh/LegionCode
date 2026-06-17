import type { ReactNode } from "react";
import type { FileStatus } from "@repo/shared-types";
import { FileCode2 } from "lucide-react";

interface ReviewFileStackProps {
  files: FileStatus[];
  selectedFile: FileStatus | null;
  emptyLabel: string;
  onSelectFile: (file: FileStatus) => void;
  children: ReactNode;
}

export function ReviewFileStack({
  files,
  selectedFile,
  emptyLabel,
  onSelectFile,
  children,
}: ReviewFileStackProps) {
  if (files.length === 0) {
    return (
      <div className="ui-surface-section flex flex-1 items-center justify-center p-4 text-sm text-zinc-500">
        {emptyLabel}
      </div>
    );
  }

  const selectedPath = selectedFile?.path ?? files[0]?.path ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1 scrollbar-hide">
      {files.map((file) => {
        const isSelected = file.path === selectedPath;
        return (
          <ReviewFileCard
            key={file.path}
            file={file}
            isSelected={isSelected}
            onSelect={() => onSelectFile(file)}
          >
            {isSelected ? children : null}
          </ReviewFileCard>
        );
      })}
    </div>
  );
}

function ReviewFileCard({
  file,
  isSelected,
  onSelect,
  children,
}: {
  file: FileStatus;
  isSelected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-800 bg-black">
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
          isSelected ? "bg-zinc-950 text-white" : "text-zinc-300 hover:bg-zinc-950"
        }`}
        aria-pressed={isSelected}
      >
        <FileCode2 size={16} className="shrink-0 text-sky-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          {formatReviewPath(file.path)}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-sm font-semibold">
          <span className="text-emerald-400">+{file.additions}</span>
          <span className="text-red-400">-{file.deletions}</span>
        </span>
      </button>
      {isSelected ? <div className="border-t border-zinc-800">{children}</div> : null}
    </section>
  );
}

function formatReviewPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 4) {
    return path;
  }

  return `.../${parts.slice(-4).join("/")}`;
}
