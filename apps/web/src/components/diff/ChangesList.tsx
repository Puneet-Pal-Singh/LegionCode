import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { FileStatus } from "@repo/shared-types";
import { ChangeItem } from "./ChangeItem";
import { ReviewScopeDropdown } from "../git/ReviewScopeDropdown";
import type { ReviewScope } from "../git/GitReviewContext";

interface ChangesListProps {
  files: FileStatus[];
  selectedFile: FileStatus | null;
  onSelectFile: (file: FileStatus) => void;
  reviewScope: ReviewScope;
  onReviewScopeChange: (scope: ReviewScope) => void;
  showToolbar?: boolean;
  className?: string;
  emptyLabel?: string;
  sourceBadgeLabel?: string;
}

interface ChangeTreeNode {
  name: string;
  path: string;
  children: Map<string, ChangeTreeNode>;
  file: FileStatus | null;
}

export function ChangesList({
  files,
  selectedFile,
  onSelectFile,
  reviewScope,
  onReviewScopeChange,
  showToolbar = true,
  className = "",
  emptyLabel = "No changes",
  sourceBadgeLabel,
}: ChangesListProps) {
  const tree = useMemo(() => buildChangeTree(files), [files]);
  const stats = useMemo(() => calculateTotals(files), [files]);

  return (
    <div className={`flex h-full flex-col bg-black ${className}`}>
      {showToolbar ? (
        <div className="border-b border-zinc-800 bg-black px-4 py-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="text-sm font-semibold text-white">Review</h3>
              {sourceBadgeLabel ? (
                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-400">
                  {sourceBadgeLabel}
                </span>
              ) : null}
            </div>
            <ChangeStats
              additions={stats.additions}
              deletions={stats.deletions}
            />
          </div>
          <ReviewScopeDropdown
            value={reviewScope}
            onChange={onReviewScopeChange}
          />
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto bg-black py-1">
        {files.length === 0 ? (
          <div className="p-4 text-center text-sm text-zinc-500">
            {emptyLabel}
          </div>
        ) : (
          Array.from(tree.children.values()).map((node) => (
            <ChangeTreeRow
              key={node.path}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ChangeTreeRow({
  node,
  depth,
  selectedFile,
  onSelectFile,
}: {
  node: ChangeTreeNode;
  depth: number;
  selectedFile: FileStatus | null;
  onSelectFile: (file: FileStatus) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const file = node.file;
  const children = Array.from(node.children.values());
  const hasChildren = children.length > 0;

  if (!file && !hasChildren) {
    return null;
  }

  const fileRow = file ? (
      <ChangeItem
        file={file}
        depth={depth}
        isSelected={selectedFile?.path === file.path}
        onSelect={() => onSelectFile(file)}
      />
  ) : null;

  if (!hasChildren) {
    return fileRow;
  }

  return (
    <div>
      {fileRow}
      <FolderRow node={node} depth={depth} expanded={expanded} onToggle={() => setExpanded((next) => !next)} />
      {expanded
        ? children.map((child) => (
            <ChangeTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
            />
          ))
        : null}
    </div>
  );
}

function FolderRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: ChangeTreeNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-900/60 hover:text-zinc-200"
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <Icon size={14} className="shrink-0 text-zinc-600" />
      <Folder size={14} className="shrink-0 text-sky-400" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function buildChangeTree(files: FileStatus[]): ChangeTreeNode {
  const root = createTreeNode("", "");
  files.forEach((file) => insertFile(root, file));
  sortTree(root);
  return root;
}

function insertFile(root: ChangeTreeNode, file: FileStatus) {
  const parts = file.path.split("/").filter(Boolean);
  let current = root;
  parts.forEach((part, index) => {
    const path = parts.slice(0, index + 1).join("/");
    const existing = current.children.get(part) ?? createTreeNode(part, path);
    if (index === parts.length - 1) {
      existing.file = file;
    }
    current.children.set(part, existing);
    current = existing;
  });
}

function sortTree(node: ChangeTreeNode) {
  const sorted = Array.from(node.children.entries()).sort(compareTreeEntries);
  node.children = new Map(sorted);
  node.children.forEach(sortTree);
}

function compareTreeEntries(
  [firstName, firstNode]: [string, ChangeTreeNode],
  [secondName, secondNode]: [string, ChangeTreeNode],
) {
  if (Boolean(firstNode.file) !== Boolean(secondNode.file)) {
    return firstNode.file ? 1 : -1;
  }
  return firstName.localeCompare(secondName);
}

function createTreeNode(name: string, path: string): ChangeTreeNode {
  return { name, path, children: new Map(), file: null };
}

function calculateTotals(files: FileStatus[]) {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

function ChangeStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-xs font-semibold">
      <span className="text-emerald-400">+{additions}</span>
      <span className="text-red-400">-{deletions}</span>
    </span>
  );
}
