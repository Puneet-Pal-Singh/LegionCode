import { useState } from "react";
import type { ReactNode } from "react";
import type { FileStatus } from "@repo/shared-types";
import { FileCode2, ChevronDown, ChevronRight } from "lucide-react";

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
  const [collapsedPath, setCollapsedPath] = useState<string | null>(null);
  const selectedPath = selectedFile?.path ?? files[0]?.path ?? null;

  if (files.length === 0) {
    return (
      <div className="ui-surface-section flex flex-1 items-center justify-center p-4 text-sm text-zinc-500">
        {emptyLabel}
      </div>
    );
  }

  const handleSelect = (file: FileStatus) => {
    if (file.path === selectedPath) {
      setCollapsedPath((previous) =>
        previous === file.path ? null : file.path,
      );
    } else {
      setCollapsedPath(null);
      onSelectFile(file);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hide">
      {files.map((file) => {
        const isSelected = file.path === selectedPath;
        const isExpanded = isSelected && collapsedPath !== file.path;
        return (
          <ReviewFileCard
            key={file.path}
            file={file}
            isSelected={isSelected}
            isExpanded={isExpanded}
            onSelect={() => handleSelect(file)}
          >
            {isExpanded ? children : null}
          </ReviewFileCard>
        );
      })}
    </div>
  );
}

function ReviewFileCard({
  file,
  isSelected,
  isExpanded,
  onSelect,
  children,
}: {
  file: FileStatus;
  isSelected: boolean;
  isExpanded: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <section className="shrink-0 bg-black">
      <button
        type="button"
        onClick={onSelect}
        className={`sticky top-0 z-10 flex w-full items-center gap-3 border-y border-zinc-800 px-4 py-3 text-left transition-colors ${
          isSelected ? "bg-zinc-900 text-white" : "bg-zinc-950 text-zinc-300 hover:bg-zinc-900"
        }`}
        aria-pressed={isSelected}
        aria-expanded={isExpanded}
      >
        {isExpanded ? (
          <ChevronDown size={16} className="shrink-0 text-zinc-400" />
        ) : (
          <ChevronRight size={16} className="shrink-0 text-zinc-400" />
        )}
        <FileCode2 size={16} className="shrink-0 text-sky-400" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm"
          style={{ direction: "rtl", textAlign: "left" }}
        >
          {formatReviewPath(file.path)}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-sm font-semibold">
          <span className="text-emerald-400">+{file.additions}</span>
          <span className="text-red-400">-{file.deletions}</span>
        </span>
      </button>
      {isExpanded ? <div>{children}</div> : null}
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
