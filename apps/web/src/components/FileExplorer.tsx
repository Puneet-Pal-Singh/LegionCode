import { useEffect, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Folder, File, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { terminalCommandPath } from '../lib/platform-endpoints';

interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileItem[];
  depth: number;
}

export interface FileExplorerHandle {
  refresh: () => void;
}

interface FileExplorerProps {
  sessionId: string;
  runId: string;
  onFileClick?: (path: string) => void;
  filterQuery?: string;
}

export const FileExplorer = forwardRef<FileExplorerHandle, FileExplorerProps>(
  ({ sessionId, runId, onFileClick, filterQuery = '' }, ref) => {
    const [files, setFiles] = useState<FileItem[]>([]);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['.']));
    const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

    const fetchFilesForPath = useCallback(async (path: string, depth: number): Promise<FileItem[]> => {
      try {
        const res = await fetch(terminalCommandPath(sessionId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plugin: "filesystem",
            payload: { action: "list_files", runId, path }
          })
        });
        
        const data = await res.json();
        
        if (data.success && typeof data.output === 'string') {
          const lines = data.output.split('\n').filter((l: string) => l.trim() && !l.includes('... and'));
          
          const seen = new Set<string>();
          const items: FileItem[] = [];

          for (const line of lines) {
            const isDir = line.endsWith('/');
            const name = isDir ? line.slice(0, -1) : line;
            
            if (seen.has(name)) continue;
            seen.add(name);

            const itemPath = path === '.' ? name : `${path}/${name}`;
            items.push({
              name,
              path: itemPath,
              type: isDir ? 'directory' : 'file',
              depth
            });
          }
          return items;
        }
      } catch (e) {
        console.error("🧬 [LegionCode] Explorer Error:", e);
      }
      return [];
    }, [sessionId, runId]);

    const refresh = useCallback(async () => {
       const rootFiles = await fetchFilesForPath('.', 0);
       setFiles(rootFiles);
    }, [fetchFilesForPath]);

    useImperativeHandle(ref, () => ({
      refresh
    }));

    useEffect(() => {
      let isMounted = true;
      
      const init = async () => {
        try {
          await refresh();
        } catch (err) {
          if (isMounted) {
            console.error("🧬 [LegionCode] Failed to initial refresh file tree:", err);
          }
        }
      };

      init();

      return () => {
        isMounted = false;
      };
    }, [refresh]);

    const toggleDirectory = async (path: string) => {
      const newExpanded = new Set(expandedPaths);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
        setExpandedPaths(newExpanded);
      } else {
        newExpanded.add(path);
        setExpandedPaths(newExpanded);
        
        // Mark as loading
        setLoadingPaths(prev => new Set(prev).add(path));
        
        const children = await fetchFilesForPath(path, 0);
        
        setFiles(prev => {
           const updateChildren = (items: FileItem[]): FileItem[] => {
              return items.map(item => {
                 if (item.path === path) {
                    return { ...item, children };
                 }
                 if (item.children) {
                    return { ...item, children: updateChildren(item.children) };
                 }
                 return item;
              });
           };
           return updateChildren(prev);
        });
        
        setLoadingPaths(prev => {
           const next = new Set(prev);
           next.delete(path);
           return next;
        });
      }
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
          {visibleFiles.map(file => renderItem(file))}
          {visibleFiles.length === 0 && (
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
