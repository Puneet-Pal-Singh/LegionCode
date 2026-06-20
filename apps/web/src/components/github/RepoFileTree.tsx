/**
 * RepoFileTree Component
 *
 * Displays a tree view of files from a GitHub repository.
 * Allows navigation through directories and file selection.
 * Follows SOLID: Single Responsibility, Dependency Inversion.
 *
 * @module components/github/RepoFileTree
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Folder,
  FolderOpen,
  ChevronRight,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { FileTypeIcon } from "../ui/FileTypeIcon";

/**
 * Tree item representing a file or folder
 */
interface TreeItem {
  path: string;
  type: "blob" | "tree";
  sha: string;
  name: string;
  level: number;
}

/**
 * Props for the RepoFileTree component
 */
interface RepoFileTreeProps {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Current branch */
  branch: string;
  /** Tree data from GitHub API */
  tree: Array<{ path: string; type: string; sha: string }>;
  /** Loading state */
  isLoading?: boolean;
  /** Callback when a file is selected */
  onFileSelect: (path: string) => void;
  /** Optional className for styling */
  className?: string;
  filterQuery?: string;
}


/**
 * Build tree structure from flat GitHub tree data
 * Maintains hierarchical order: items sorted within their parent directory
 */
function buildTree(
  tree: Array<{ path: string; type: string; sha: string }>,
): TreeItem[] {
  const items: TreeItem[] = [];

  // Group items by their parent directory
  const itemsByParent = new Map<string, typeof tree>();

  for (const item of tree) {
    const lastSlashIndex = item.path.lastIndexOf("/");
    const parentPath =
      lastSlashIndex === -1 ? "" : item.path.substring(0, lastSlashIndex);

    if (!itemsByParent.has(parentPath)) {
      itemsByParent.set(parentPath, []);
    }
    itemsByParent.get(parentPath)?.push(item);
  }

  // Sort items within each parent directory: folders first, then alphabetically
  for (const [, siblings] of itemsByParent) {
    siblings.sort((a, b) => {
      const aIsDir = a.type === "tree";
      const bIsDir = b.type === "tree";

      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.path.localeCompare(b.path);
    });
  }

  // Build flat list recursively starting from root
  const addedPaths = new Set<string>();

  function addItemsInOrder(parentPath: string) {
    const siblings = itemsByParent.get(parentPath) || [];

    for (const item of siblings) {
      if (addedPaths.has(item.path)) continue;

      const parts = item.path.split("/");
      const name = parts[parts.length - 1] ?? "";
      const level = parts.length - 1;

      items.push({
        path: item.path,
        type: item.type as "blob" | "tree",
        sha: item.sha,
        name,
        level,
      });
      addedPaths.add(item.path);

      // If this is a directory, recursively add its children immediately after
      if (item.type === "tree") {
        addItemsInOrder(item.path);
      }
    }
  }

  addItemsInOrder("");
  return items;
}

/**
 * RepoFileTree Component
 *
 * Renders a navigable tree of repository files and folders.
 *
 * @example
 * ```tsx
 * <RepoFileTree
 *   owner="facebook"
 *   repo="react"
 *   branch="main"
 *   tree={treeData}
 *   onFileSelect={(path) => console.log("Selected:", path)}
 * />
 * ```
 */
export function RepoFileTree({
  owner,
  repo,
  branch,
  tree,
  isLoading = false,
  onFileSelect,
  className,
  filterQuery = "",
}: RepoFileTreeProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set([""]), // Root is expanded by default
  );

  // Reset expanded folders when tree changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedFolders(new Set([""]));
  }, [tree]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const treeItems = buildTree(tree);

  // Filter items to only show those in expanded folders
  const visibleItems = filterVisibleItems(
    treeItems,
    expandedFolders,
    filterQuery,
  );

  return (
    <div className={cn("py-2", className)}>
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-1 px-3 py-2"
          >
            {/* Repo Info Skeleton */}
            <div className="flex items-center gap-2 mb-4">
              <div className="h-3 w-16 bg-zinc-800 rounded animate-pulse" />
              <div className="h-3 w-4 bg-zinc-900 rounded animate-pulse" />
              <div className="h-3 w-24 bg-zinc-800 rounded animate-pulse" />
            </div>
            
            {/* Tree Skeletons */}
            {[...Array(8)].map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-2 py-1"
                style={{ paddingLeft: `${(i % 3) * 12}px` }}
              >
                <div className="w-3.5 h-3.5 bg-zinc-800 rounded animate-pulse shrink-0" />
                <div className="h-3 bg-zinc-800 rounded animate-pulse" style={{ width: `${40 + (i * 10) % 40}%` }} />
              </div>
            ))}
          </motion.div>
        ) : treeItems.length === 0 ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center py-8 text-zinc-500"
          >
            <Folder size={32} className="mb-2 opacity-50" />
            <span className="text-sm">No files found</span>
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {/* Header showing repo info */}
            <div className="px-3 py-2 mb-2 border-b border-zinc-800/50">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="font-medium text-zinc-300">{owner}</span>
                <span className="text-zinc-600">/</span>
                <span className="font-medium text-white">{repo}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-1 text-[10px] text-zinc-500">
                <span className="px-1.5 py-0.5 bg-zinc-800/50 rounded">{branch}</span>
                <span>•</span>
                <span>{tree.length} items</span>
              </div>
            </div>

            {/* Tree items */}
            <div className="space-y-0.5">
              <AnimatePresence initial={false}>
                {visibleItems.map((item) => {
                  const isFolder = item.type === "tree";
                  const isExpanded = expandedFolders.has(item.path);
                  const indent = item.level * 12;

                  return (
                    <motion.div
                      key={item.sha}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      transition={{ duration: 0.1 }}
                    >
                      {isFolder ? (
                        <button
                          onClick={() => toggleFolder(item.path)}
                          className={cn(
                            "w-full flex items-center gap-1.5 px-2 py-1.5 text-left",
                            "hover:bg-zinc-800/50 transition-colors duration-150",
                            "group",
                          )}
                          style={{ paddingLeft: `${12 + indent}px` }}
                        >
                          <motion.div
                            animate={{ rotate: isExpanded ? 90 : 0 }}
                            transition={{ duration: 0.15 }}
                            className="text-zinc-500 group-hover:text-zinc-400"
                          >
                            <ChevronRight size={14} />
                          </motion.div>
                          {isExpanded ? (
                            <FolderOpen size={14} className="text-blue-400" />
                          ) : (
                            <Folder size={14} className="text-blue-400" />
                          )}
                          <span className="text-sm text-zinc-300 group-hover:text-white truncate">
                            {item.name}
                          </span>
                        </button>
                      ) : (
                        <button
                          onClick={() => onFileSelect(item.path)}
                          className={cn(
                            "w-full flex items-center gap-1.5 px-2 py-1.5 text-left",
                            "hover:bg-zinc-800/50 transition-colors duration-150",
                            "group",
                          )}
                          style={{ paddingLeft: `${28 + indent}px` }}
                        >
                          <FileTypeIcon path={item.path} size={14} />
                          <span className="text-sm text-zinc-400 group-hover:text-zinc-200 truncate">
                            {item.name}
                          </span>
                        </button>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function filterVisibleItems(
  items: TreeItem[],
  expandedFolders: Set<string>,
  query: string,
): TreeItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    const visiblePaths = new Set<string>();
    items.forEach((item) => {
      if (!item.path.toLowerCase().includes(normalizedQuery)) return;
      addPathAndParents(visiblePaths, item.path);
    });
    return items.filter((item) => visiblePaths.has(item.path));
  }

  return items.filter((item) => {
    if (item.level === 0) return true;
    const parentPath = item.path.substring(0, item.path.lastIndexOf("/"));
    return expandedFolders.has(parentPath);
  });
}

function addPathAndParents(paths: Set<string>, path: string) {
  const parts = path.split("/");
  parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
}

export type { TreeItem, RepoFileTreeProps };
