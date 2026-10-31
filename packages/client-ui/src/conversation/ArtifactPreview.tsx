import { Maximize2, FileCode, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { cn } from "../classnames.js";

interface ArtifactPreviewProps {
  title: string;
  content: string | { type: 'r2_ref'; key: string };
  onOpen: (path: string, content: string) => void;
  status: 'submitted' | 'call' | 'result' | 'partial-call';
  loadContent?: (key: string, signal?: AbortSignal) => Promise<string>;
}

type ContentState =
  | { identity: string; loader?: ArtifactPreviewProps["loadContent"]; status: "loading" }
  | { identity: string; loader?: ArtifactPreviewProps["loadContent"]; status: "error" }
  | { identity: string; loader?: ArtifactPreviewProps["loadContent"]; status: "ready"; content: string };

export function ArtifactPreview({ title, content: initialContent, onOpen, status, loadContent }: ArtifactPreviewProps) {
  const identity = typeof initialContent === "string"
    ? `inline:${initialContent}`
    : `r2:${initialContent.key}`;
  const referenceKey = typeof initialContent === "string" ? null : initialContent.key;
  const [contentState, setContentState] = useState<ContentState | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const isRunning = status === 'call' || status === 'partial-call';
  const currentState: ContentState = typeof initialContent === "string"
    ? { identity, status: "ready", content: initialContent }
    : contentState?.identity === identity && contentState.loader === loadContent
      ? contentState
      : { identity, status: "loading" };
  const content = currentState.status === "ready" ? currentState.content : "";

  useEffect(() => {
    if (referenceKey === null) return;

    const controller = new AbortController();
    setContentState({ identity, loader: loadContent, status: "loading" });
    if (!loadContent) {
      setContentState({ identity, loader: loadContent, status: "error" });
      return () => controller.abort();
    }

    void loadContent(referenceKey, controller.signal).then(
      (resolvedContent) => {
        if (!controller.signal.aborted) {
          setContentState({ identity, loader: loadContent, status: "ready", content: resolvedContent });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setContentState({ identity, loader: loadContent, status: "error" });
        }
      },
    );
    return () => controller.abort();
  }, [identity, referenceKey, loadContent, retryCount]);

  const open = () => {
    if (currentState.status === "ready" && !isRunning) {
      onOpen(title, currentState.content);
    }
  };

  return (
    <div className={cn(
      "w-full max-w-full my-4 rounded-xl border bg-zinc-900/50 overflow-hidden transition-all shadow-lg",
      isRunning ? "border-zinc-800 opacity-70" : "border-zinc-800 hover:border-zinc-700"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/80 border-b border-zinc-800">
        <div className="flex items-center gap-2 overflow-hidden">
          <FileCode size={14} className="text-emerald-500 shrink-0" />
          <span className="text-[11px] font-mono text-zinc-300 truncate">{title}</span>
        </div>
        {!isRunning && currentState.status === "ready" && (
          <button
            onClick={open}
            className="p-1.5 hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Open Full View"
          >
            <Maximize2 size={12} />
          </button>
        )}
      </div>

      {/* Code Glimpse */}
      <div className="relative max-h-48 overflow-hidden group min-h-[100px] flex flex-col">
        {currentState.status === "loading" ? (
          <div className="flex-1 flex items-center justify-center bg-zinc-950/20">
            <Loader2 size={16} className="animate-spin text-zinc-600" />
          </div>
        ) : currentState.status === "error" ? (
          <div className="flex flex-col items-center justify-center gap-2 p-5 text-center">
            <p className="text-xs text-zinc-400">Could not load this file.</p>
            <button
              type="button"
              onClick={() => setRetryCount((count) => count + 1)}
              className="rounded-md border border-zinc-700 px-3 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-800"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <SyntaxHighlighter
              language={title.split('.').pop() || 'typescript'}
              style={vscDarkPlus}
              PreTag="div"
              showLineNumbers={true}
              customStyle={{
                margin: 0,
                width: '100%',
                background: 'transparent',
                padding: '1rem',
                fontSize: '11px',
                fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
              }}
            >
              {content}
            </SyntaxHighlighter>
            
            {/* Fade overlay for long code */}
            {!isRunning && content.split('\n').length > 8 && (
              <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-zinc-950/80 to-transparent flex items-end justify-center pb-2">
                <button
                  onClick={open}
                  className="text-[10px] font-bold text-zinc-400 hover:text-white uppercase tracking-wider bg-zinc-900/80 px-3 py-1 rounded-full border border-zinc-800 backdrop-blur-sm"
                >
                  Show Full File
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
