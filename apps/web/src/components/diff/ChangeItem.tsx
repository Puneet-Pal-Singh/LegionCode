import type { FileStatus } from "@repo/shared-types";

interface ChangeItemProps {
  file: FileStatus;
  depth: number;
  isSelected: boolean;
  onSelect: () => void;
}

const statusColors: Record<FileStatus["status"], string> = {
  modified: "text-yellow-400",
  added: "text-green-400",
  deleted: "text-red-400",
  renamed: "text-blue-400",
  untracked: "text-zinc-500",
};

const statusLabels: Record<FileStatus["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

export function ChangeItem({
  file,
  depth,
  isSelected,
  onSelect,
}: ChangeItemProps) {
  const fileName = file.path.split("/").pop() || file.path;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
        isSelected ? "bg-zinc-900 text-white" : "text-zinc-300 hover:bg-zinc-900/50 hover:text-white"
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <span className={`w-4 shrink-0 font-mono text-xs font-bold ${statusColors[file.status]}`}>
        {statusLabels[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{fileName}</span>
      <ChangeItemStats file={file} />
    </button>
  );
}

function ChangeItemStats({ file }: { file: FileStatus }) {
  return (
    <span className="flex shrink-0 gap-2 text-xs text-zinc-500">
      {file.additions > 0 ? (
        <span className="text-emerald-500">+{file.additions}</span>
      ) : null}
      {file.deletions > 0 ? (
        <span className="text-red-500">-{file.deletions}</span>
      ) : null}
    </span>
  );
}
