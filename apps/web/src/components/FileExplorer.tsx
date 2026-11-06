import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Folder, File, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@legioncode/client-ui';
import { listCheckoutFiles } from '../services/api/checkoutReads';
import { useAuth } from '../contexts/AuthContext';

interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileItem[];
  depth: number;
}
export interface FileExplorerHandle { refresh: () => void; }
interface FileExplorerProps {
  sessionId: string;
  runId: string;
  onFileClick?: (path: string) => void;
  filterQuery?: string;
}
export const FileExplorer = forwardRef<FileExplorerHandle, FileExplorerProps>(
  ({ sessionId, runId, onFileClick, filterQuery = '' }, ref) => {
    const { user, isAuthenticated } = useAuth();
    const [files, setFiles] = useState<FileItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [truncated, setTruncated] = useState(false);
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
      setTruncated(false);
      setExpandedPaths(new Set(['.']));
      setLoadingPaths(new Set());
      return cancel;
    }, [cancel, sessionId, runId, user?.id, user?.workspaceId, isAuthenticated]);

    const fetchFilesForPath = useCallback(async (path: string, depth: number): Promise<FileItem[] | null> => {
      if (!isAuthenticated || !user) return null;
      requests.current.get(path)?.abort();
      const request = new AbortController();
      requests.current.set(path, request);
      const capturedGeneration = generation.current;
      const isCurrent = () => !request.signal.aborted && generation.current === capturedGeneration && requests.current.get(path) === request;
      setLoadingPaths((current) => new Set(current).add(path));
      try {
        const result = await listCheckoutFiles(sessionId, runId, path, request.signal);
        if (!isCurrent()) return null;
        setError(null);
        if (result.truncated) setTruncated(true);
        return result.entries.map((entry) => ({ ...entry, path: path === '.' ? entry.name : `${path}/${entry.name}`, depth }));
      } catch (requestError) {
        if (isCurrent()) setError(requestError instanceof Error ? requestError.message : 'The checkout files could not be listed.');
        return null;
      } finally {
        if (isCurrent()) {
          requests.current.delete(path);
          setLoadingPaths((current) => { const next = new Set(current); next.delete(path); return next; });
        }
      }
    }, [isAuthenticated, user, sessionId, runId]);

    const refresh = useCallback(async () => {
      cancel();
      setLoadingPaths(new Set());
      setTruncated(false);
      const capturedGeneration = generation.current;
      const rootFiles = await fetchFilesForPath('.', 0);
      if (generation.current === capturedGeneration && rootFiles) { setFiles(rootFiles); setExpandedPaths(new Set(['.'])); }
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
        ? { ...item, children }
        : item.children ? { ...item, children: updateChildren(item.children) } : item);
      setFiles((current) => updateChildren(current));
    };

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
          {truncated ? <p className="px-4 py-2 text-xs text-zinc-400">Some directories show only their first 20 entries.</p> : null}
          {visibleFiles.map(file => renderItem(file))}
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
