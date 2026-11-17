import type { ArtifactChangedFile } from "@repo/platform-protocol";
import type { FileStatus } from "@repo/shared-types";
import { FileTypeIcon } from "./FileTypeIcon.js";

/** Saved artifact counts may be unknown; live Git FileStatus remains compatible. */
export type ReviewFileStatus = Omit<FileStatus, "additions" | "deletions"> &
  Pick<ArtifactChangedFile, "additions" | "deletions">;

type ChangeItemFile = Pick<ReviewFileStatus, "path" | "additions" | "deletions"> & {
  status: FileStatus["status"] | ArtifactChangedFile["status"];
};
interface ChangeItemProps {
  file: ChangeItemFile;
  depth: number;
  isSelected: boolean;
  onSelect: () => void;
  pressed?: boolean;
  disabled?: boolean;
  showFullPath?: boolean;
}

const statusColors: Record<ChangeItemFile["status"], string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400",
  renamed: "text-blue-400",
  untracked: "text-zinc-500",
  copied: "text-blue-400",
  unchanged: "text-zinc-500",
};

const statusLabels: Record<ChangeItemFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  copied: "C",
  unchanged: "=",
};

export function ChangeItem({
  file,
  depth,
  isSelected,
  onSelect,
  pressed,
  disabled,
  showFullPath = false,
}: ChangeItemProps) {
  const fileName = file.path.split("/").pop() || file.path;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={pressed}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        isSelected ? "bg-zinc-900 text-white" : "text-zinc-300 hover:bg-zinc-900/50 hover:text-white"
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <span className={`w-4 shrink-0 font-mono text-xs font-bold ${statusColors[file.status]}`}>
        {statusLabels[file.status]}
      </span>
      <FileTypeIcon path={file.path} size={15} />
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{showFullPath ? file.path : fileName}</span>
      <ChangeItemStats file={file} />
    </button>
  );
}

function ChangeItemStats({ file }: { file: ChangeItemFile }) {
  return (
    <span className="flex shrink-0 gap-2 text-xs text-zinc-500">
      {file.additions === null ? <span>Additions unavailable</span> : file.additions > 0 ? (
        <span className="text-emerald-500">+{file.additions}</span>
      ) : null}
      {file.deletions === null ? <span>Deletions unavailable</span> : file.deletions > 0 ? (
        <span className="text-red-500">-{file.deletions}</span>
      ) : null}
    </span>
  );
}
