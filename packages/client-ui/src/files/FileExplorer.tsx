import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Folder, File, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../classnames.js';
import { TreeFilter } from '../review/TreeFilter.js';
export type FileExplorerCursor = string | number;
export interface FileExplorerEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  unavailableReason?: string;
}
export interface FileExplorerPage {
  entries: FileExplorerEntry[];
  nextCursor: FileExplorerCursor | null;
}
export type FileExplorerReadPort = (path: string, cursor: FileExplorerCursor | null, signal: AbortSignal) => Promise<FileExplorerPage>;

interface FileItem extends FileExplorerEntry {
  name: string;
  path: string;
  children?: FileItem[];
  nextCursor?: FileExplorerCursor | null;
  depth: number;
}
export interface FileExplorerHandle { refresh: () => void; }
export interface SharedFileExplorerProps {
  scopeKey: string;
  enabled: boolean;
  listFiles: FileExplorerReadPort;
  onFileClick?: (path: string) => void;
  filterQuery?: string;
  showFilter?: boolean;
}
export const SharedFileExplorer = forwardRef<FileExplorerHandle, SharedFileExplorerProps>(
  ({ scopeKey, enabled, listFiles, onFileClick, filterQuery = '', showFilter = false }, ref) => {
    const [localFilter, setLocalFilter] = useState('');
    const query = showFilter ? localFilter : filterQuery;
    const [files, setFiles] = useState<FileItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [nextCursor, setNextCursor] = useState<FileExplorerCursor | null>(null);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['.']));
    const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
    const generation = useRef(0);
    const requests = useRef(new Map<string, AbortController>());
    const cancel = useCallback(() => {
      generation.current += 1;
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    }, []);
    useLayoutEffect(() => {
      cancel();
      setFiles([]);
      setError(null);
      setNextCursor(null);
      setExpandedPaths(new Set(['.']));
      setLoadingPaths(new Set());
      return cancel;
    }, [cancel, scopeKey, enabled, listFiles]);

    const fetchFilesForPath = useCallback(async (path: string, cursor: FileExplorerCursor | null = null): Promise<{ items: FileItem[]; nextCursor: FileExplorerCursor | null } | null> => {
      if (!enabled) return null;
      requests.current.get(path)?.abort();
      const request = new AbortController();
      requests.current.set(path, request);
      const capturedGeneration = generation.current;
      const isCurrent = () => !request.signal.aborted && generation.current === capturedGeneration && requests.current.get(path) === request;
      setLoadingPaths((current) => new Set(current).add(path));
      try {
        const result = await listFiles(path, cursor, request.signal);
        if (!isCurrent()) return null;
        setError(null);
        return {
          items: result.entries.map((entry) => ({ ...entry, depth: 0 })),
          nextCursor: result.nextCursor,
        };
      } catch (requestError) {
        if (isCurrent()) setError(requestError instanceof Error ? requestError.message : 'The workspace files could not be listed.');
        return null;
      } finally {
        if (isCurrent()) {
          requests.current.delete(path);
          setLoadingPaths((current) => { const next = new Set(current); next.delete(path); return next; });
        }
      }
    }, [enabled, listFiles]);

    const refresh = useCallback(async () => {
      cancel();
      setLoadingPaths(new Set());
      setNextCursor(null);
      const capturedGeneration = generation.current;
      const rootFiles = await fetchFilesForPath('.', null);
      if (generation.current === capturedGeneration && rootFiles) {
        setFiles(rootFiles.items);
        setNextCursor(rootFiles.nextCursor);
        setExpandedPaths(new Set(['.']));
      }
    }, [cancel, fetchFilesForPath]);
    useImperativeHandle(ref, () => ({ refresh: () => { void refresh(); } }), [refresh]);
    useEffect(() => { void refresh(); }, [refresh]);

    const toggleDirectory = async (path: string) => {
      const next = new Set(expandedPaths);
      if (next.has(path)) { next.delete(path); setExpandedPaths(next); return; }
      next.add(path);
      setExpandedPaths(next);
      const capturedGeneration = generation.current;
      const children = await fetchFilesForPath(path, null);
      if (generation.current !== capturedGeneration || !children) return;
      const updateChildren = (items: FileItem[]): FileItem[] => items.map((item) => item.path === path
        ? { ...item, children: children.items, nextCursor: children.nextCursor }
        : item.children ? { ...item, children: updateChildren(item.children) } : item);
      setFiles((current) => updateChildren(current));
    };

    const loadMore = async (path: string, cursor: FileExplorerCursor) => {
      const capturedGeneration = generation.current;
      const page = await fetchFilesForPath(path, cursor);
      if (generation.current !== capturedGeneration || !page) return;
      const append = (existing: FileItem[]) => {
        const paths = new Set(existing.map((item) => item.path));
        return [...existing, ...page.items.filter((item) => !paths.has(item.path))];
      };
      if (path === '.') {
        setFiles(append);
        setNextCursor(page.nextCursor);
      } else {
        const update = (items: FileItem[]): FileItem[] => items.map((item) => item.path === path
          ? { ...item, children: append(item.children ?? []), nextCursor: page.nextCursor }
          : item.children ? { ...item, children: update(item.children) } : item);
        setFiles(update);
      }
    };
    const renderLoadMore = (path: string, cursor: FileExplorerCursor) => (
      <button type="button" disabled={loadingPaths.has(path)}
        className="mx-4 my-2 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
        onClick={() => { void loadMore(path, cursor); }}>
        {loadingPaths.has(path) ? 'Loading…' : `Load more files in ${path}`}
      </button>
    );

    const renderItem = (item: FileItem) => {
      const isExpanded = expandedPaths.has(item.path);
      const isLoading = loadingPaths.has(item.path);
      const isDir = item.type === 'directory';
      const unavailable = !!item.unavailableReason || (item.type !== 'file' && !isDir);

      return (
        <div key={item.path} className="flex flex-col">
          <button
            type="button"
            disabled={unavailable}
            aria-expanded={isDir ? isExpanded : undefined}
            title={item.unavailableReason ?? (unavailable ? `${item.type} entries cannot be opened` : item.path)}
            onClick={() => isDir ? toggleDirectory(item.path) : onFileClick?.(item.path)}
            className={cn(
               "flex items-center gap-1.5 p-1 px-2 hover:bg-zinc-800/50 rounded group cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            )}
            style={{ paddingLeft: `${item.depth * 12 + 8}px` }}
          >
            {isDir ? (
               <>
                  {isLoading ? (
                    <Loader2 size={14} className="text-zinc-500 animate-spin" />
                  ) : isExpanded ? (
                    <ChevronDown size={14} className="text-zinc-500" />
                  ) : (
                    <ChevronRight size={14} className="text-zinc-500" />
                  )}
                  <Folder size={14} className="text-blue-500/80 shrink-0" />
               </>
            ) : (
              <>
                 <div className="w-3.5" />
                 <File size={14} className="text-zinc-500 group-hover:text-emerald-500 shrink-0 transition-colors" />
              </>
            )}
            <span className={cn(
               "text-[12px] truncate transition-colors",
               isDir ? "text-zinc-300 font-medium" : "text-zinc-400 group-hover:text-white"
            )}>
               {item.name}
            </span>
            {unavailable ? <span className="ml-auto text-[10px] text-zinc-500">{item.type === 'file' || isDir ? 'Unavailable' : item.type === 'symlink' ? 'Symbolic link' : 'Special entry'}</span> : null}
          </button>
          
          {isDir && isExpanded && item.children && (
            <div className="flex flex-col">
              {item.children.map(child => renderItem({ ...child, depth: item.depth + 1 }))}
              {item.nextCursor != null ? renderLoadMore(item.path, item.nextCursor) : null}
            </div>
          )}
        </div>
      );
    };

    const visibleFiles = useMemo(
      () => filterFileItems(files, query),
      [files, query],
    );

    return (
      <div className="flex flex-col h-full bg-black select-none">
        {showFilter ? <TreeFilter value={localFilter} onChange={setLocalFilter} placeholder="Filter loaded files..." /> : null}
        <div className="flex-1 overflow-y-auto py-2">
          {error ? <p role="alert" className="px-4 py-3 text-xs text-rose-300">{error}</p> : null}
          {visibleFiles.map(file => renderItem(file))}
          {nextCursor !== null ? renderLoadMore('.', nextCursor) : null}
          {loadingPaths.has('.') && files.length === 0 ? <p role="status" className="px-4 py-3 text-xs text-zinc-400">Loading files…</p> : null}
          {visibleFiles.length === 0 && !error && !loadingPaths.size && (
             <div className="px-4 py-8 text-center">
                <p className="text-xs text-zinc-600 italic">No files found</p>
             </div>
          )}
        </div>
      </div>
    );
  }
);

SharedFileExplorer.displayName = 'SharedFileExplorer';

function filterFileItems(items: FileItem[], query: string): FileItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  return items.flatMap((item) => {
    const children = filterFileItems(item.children ?? [], normalizedQuery);
    const matches = item.path.toLowerCase().includes(normalizedQuery);
    return matches || children.length > 0 ? [{ ...item, children }] : [];
  });
}
