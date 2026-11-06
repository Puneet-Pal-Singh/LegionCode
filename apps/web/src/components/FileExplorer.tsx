import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Folder, File, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@legioncode/client-ui';
import { type CheckoutTurnIdentity, listCheckoutFiles } from '../services/api/checkoutReads';
import { useAuth } from '../contexts/AuthContext';

interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileItem[];
  nextOffset?: number | null;
  depth: number;
}
export interface FileExplorerHandle { refresh: () => void; }
interface FileExplorerProps {
  sessionId: string;
  runId: string;
  checkoutTurn?: CheckoutTurnIdentity;
  onFileClick?: (path: string) => void;
  filterQuery?: string;
}
export const FileExplorer = forwardRef<FileExplorerHandle, FileExplorerProps>(
  ({ sessionId, runId, checkoutTurn, onFileClick, filterQuery = '' }, ref) => {
    const { user, isAuthenticated } = useAuth();
    const [files, setFiles] = useState<FileItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
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
      setNextOffset(null);
      setExpandedPaths(new Set(['.']));
      setLoadingPaths(new Set());
      return cancel;
    }, [cancel, sessionId, runId, checkoutTurn?.turnId, checkoutTurn?.runAttemptId, user?.id, user?.workspaceId, isAuthenticated]);

    const fetchFilesForPath = useCallback(async (path: string, offset = 0): Promise<{ items: FileItem[]; nextOffset: number | null } | null> => {
      if (!isAuthenticated || !user) return null;
      requests.current.get(path)?.abort();
      const request = new AbortController();
      requests.current.set(path, request);
      const capturedGeneration = generation.current;
      const isCurrent = () => !request.signal.aborted && generation.current === capturedGeneration && requests.current.get(path) === request;
      setLoadingPaths((current) => new Set(current).add(path));
      try {
        if (!checkoutTurn) throw new Error("Start a task before browsing its checkout.");
        const result = await listCheckoutFiles({ sessionId, runId, turnId: checkoutTurn.turnId, runAttemptId: checkoutTurn.runAttemptId, path, offset }, request.signal);
        if (!isCurrent()) return null;
        setError(null);
        return {
          items: result.entries.map((entry) => ({ ...entry, path: path === '.' ? entry.name : `${path}/${entry.name}`, depth: 0 })),
          nextOffset: result.nextOffset,
        };
      } catch (requestError) {
        if (isCurrent()) setError(requestError instanceof Error ? requestError.message : 'The checkout files could not be listed.');
        return null;
      } finally {
        if (isCurrent()) {
          requests.current.delete(path);
          setLoadingPaths((current) => { const next = new Set(current); next.delete(path); return next; });
        }
      }
    }, [isAuthenticated, user, sessionId, runId, checkoutTurn]);

    const refresh = useCallback(async () => {
      cancel();
      setLoadingPaths(new Set());
      setNextOffset(null);
      const capturedGeneration = generation.current;
      const rootFiles = await fetchFilesForPath('.', 0);
      if (generation.current === capturedGeneration && rootFiles) {
        setFiles(rootFiles.items);
        setNextOffset(rootFiles.nextOffset);
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
      const children = await fetchFilesForPath(path, 0);
      if (generation.current !== capturedGeneration || !children) return;
      const updateChildren = (items: FileItem[]): FileItem[] => items.map((item) => item.path === path
        ? { ...item, children: children.items, nextOffset: children.nextOffset }
        : item.children ? { ...item, children: updateChildren(item.children) } : item);
      setFiles((current) => updateChildren(current));
    };

    const loadMore = async (path: string, offset: number) => {
      const capturedGeneration = generation.current;
      const page = await fetchFilesForPath(path, offset);
      if (generation.current !== capturedGeneration || !page) return;
      const append = (existing: FileItem[]) => {
        const paths = new Set(existing.map((item) => item.path));
        return [...existing, ...page.items.filter((item) => !paths.has(item.path))];
      };
      if (path === '.') {
        setFiles(append);
        setNextOffset(page.nextOffset);
      } else {
        const update = (items: FileItem[]): FileItem[] => items.map((item) => item.path === path
          ? { ...item, children: append(item.children ?? []), nextOffset: page.nextOffset }
          : item.children ? { ...item, children: update(item.children) } : item);
        setFiles(update);
      }
    };
    const renderLoadMore = (path: string, offset: number) => (
      <button type="button" disabled={loadingPaths.has(path)}
        className="mx-4 my-2 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
        onClick={() => { void loadMore(path, offset); }}>
        {loadingPaths.has(path) ? 'Loading…' : `Load more files in ${path}`}
      </button>
    );

    const renderItem = (item: FileItem) => {
      const isExpanded = expandedPaths.has(item.path);
      const isLoading = loadingPaths.has(item.path);
      const isDir = item.type === 'directory';

      return (
        <div key={item.path} className="flex flex-col">
          <div 
            onClick={() => isDir ? toggleDirectory(item.path) : onFileClick?.(item.path)}
            className={cn(
               "flex items-center gap-1.5 p-1 px-2 hover:bg-zinc-800/50 rounded group cursor-pointer transition-colors"
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
          </div>
          
          {isDir && isExpanded && item.children && (
            <div className="flex flex-col">
              {item.children.map(child => renderItem({ ...child, depth: item.depth + 1 }))}
              {item.nextOffset != null ? renderLoadMore(item.path, item.nextOffset) : null}
            </div>
          )}
        </div>
      );
    };

    const visibleFiles = useMemo(
      () => filterFileItems(files, filterQuery),
      [files, filterQuery],
    );

    return (
      <div className="flex flex-col h-full bg-black select-none">
        <div className="flex-1 overflow-y-auto py-2">
          {error ? <p role="alert" className="px-4 py-3 text-xs text-rose-300">{error}</p> : null}
          {visibleFiles.map(file => renderItem(file))}
          {nextOffset !== null ? renderLoadMore('.', nextOffset) : null}
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

FileExplorer.displayName = 'FileExplorer';

function filterFileItems(items: FileItem[], query: string): FileItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  return items.flatMap((item) => {
    const children = filterFileItems(item.children ?? [], normalizedQuery);
    const matches = item.path.toLowerCase().includes(normalizedQuery);
    return matches || children.length > 0 ? [{ ...item, children }] : [];
  });
}
