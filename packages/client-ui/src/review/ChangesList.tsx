import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { FileStatus } from "@repo/shared-types";
import { ChangeItem, type ReviewFileStatus } from "./ChangeItem.js";
import { ReviewScopeDropdown } from "./ReviewScopeDropdown.js";
import type { ReviewScope } from "./reviewScope.js";
import { TreeFilter } from "./TreeFilter.js";

interface ChangesListProps<TFile extends ReviewFileStatus> {
  files: TFile[];
  selectedFile: TFile | null;
  onSelectFile: (file: TFile) => void;
  reviewScope: ReviewScope;
  onReviewScopeChange: (scope: ReviewScope) => void;
  showToolbar?: boolean;
  className?: string;
  emptyLabel?: string;
  sourceBadgeLabel?: string;
  searchable?: boolean;
  canonicalAvailable?: boolean;
}

interface ChangeTreeNode<TFile extends ReviewFileStatus = ReviewFileStatus> {
  name: string;
  path: string;
  children: Map<string, ChangeTreeNode<TFile>>;
  file: TFile | null;
}

export function ChangesList<TFile extends ReviewFileStatus = FileStatus>({
  files,
  selectedFile,
  onSelectFile,
  reviewScope,
  onReviewScopeChange,
  showToolbar = true,
  className = "",
  emptyLabel = "No changes",
  sourceBadgeLabel,
  searchable = false,
  canonicalAvailable = false,
}: ChangesListProps<TFile>) {
  const [query, setQuery] = useState("");
  const visibleFiles = useMemo(
    () => filterFiles(files, query),
    [files, query],
  );
  const tree = useMemo(() => buildChangeTree(visibleFiles), [visibleFiles]);
  const stats = useMemo(() => calculateTotals(files), [files]);

  return (
    <div
      className={`flex h-full min-w-0 flex-1 flex-col bg-black ${className}`}
    >
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
          canonicalAvailable={canonicalAvailable}
          />
        </div>
      ) : null}

      {searchable ? <TreeFilter value={query} onChange={setQuery} /> : null}

      <div className="flex-1 overflow-y-auto bg-black py-1">
        {visibleFiles.length === 0 ? (
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

function filterFiles<TFile extends ReviewFileStatus>(files: TFile[], query: string): TFile[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return files;
  return files.filter((file) =>
    file.path.toLowerCase().includes(normalizedQuery),
  );
}

function ChangeTreeRow<TFile extends ReviewFileStatus>({
  node,
  depth,
  selectedFile,
  onSelectFile,
}: {
  node: ChangeTreeNode<TFile>;
  depth: number;
  selectedFile: TFile | null;
  onSelectFile: (file: TFile) => void;
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
  node: Pick<ChangeTreeNode, "name">;
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

function buildChangeTree<TFile extends ReviewFileStatus>(files: TFile[]): ChangeTreeNode<TFile> {
  const root = createTreeNode<TFile>("", "");
  files.forEach((file) => insertFile(root, file));
  sortTree(root);
  return root;
}

function insertFile<TFile extends ReviewFileStatus>(root: ChangeTreeNode<TFile>, file: TFile) {
  const parts = file.path.split("/").filter(Boolean);
  let current = root;
  parts.forEach((part, index) => {
    const path = parts.slice(0, index + 1).join("/");
    const existing = current.children.get(part) ?? createTreeNode<TFile>(part, path);
    if (index === parts.length - 1) {
      existing.file = file;
    }
    current.children.set(part, existing);
    current = existing;
  });
}

function sortTree<TFile extends ReviewFileStatus>(node: ChangeTreeNode<TFile>) {
  const sorted = Array.from(node.children.entries()).sort(compareTreeEntries);
  node.children = new Map(sorted);
  node.children.forEach(sortTree);
}

function compareTreeEntries<TFile extends ReviewFileStatus>(
  [firstName, firstNode]: [string, ChangeTreeNode<TFile>],
  [secondName, secondNode]: [string, ChangeTreeNode<TFile>],
) {
  if (Boolean(firstNode.file) !== Boolean(secondNode.file)) {
    return firstNode.file ? 1 : -1;
  }
  return firstName.localeCompare(secondName);
}

function createTreeNode<TFile extends ReviewFileStatus>(name: string, path: string): ChangeTreeNode<TFile> {
  return { name, path, children: new Map(), file: null };
}

function calculateTotals(files: ReviewFileStatus[]) {
  return files.reduce<{ additions: number | null; deletions: number | null }>(
    (totals, file) => ({
      additions: totals.additions === null || file.additions === null ? null : totals.additions + file.additions,
      deletions: totals.deletions === null || file.deletions === null ? null : totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

function ChangeStats({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-xs font-semibold">
      {additions === null ? <span>Additions unavailable</span> : <span className="text-emerald-400">+{additions}</span>}
      {deletions === null ? <span>Deletions unavailable</span> : <span className="text-red-400">-{deletions}</span>}
    </span>
  );
}
