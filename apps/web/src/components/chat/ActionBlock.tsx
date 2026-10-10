import { Loader2, CheckCircle2 } from "lucide-react";
import { cn } from "@legioncode/client-ui";

interface ActionBlockProps {
  tool: string;
  // AI SDK states
  status: 'submitted' | 'call' | 'result' | 'partial-call'; 
  args?: Record<string, unknown>;
}

export function ActionBlock({ tool, status, args }: ActionBlockProps) {
  // Safe extraction of path
  const filePath = args && typeof args.path === 'string' ? args.path : null;
  
  // Mapping SDK states to visual states
  const isRunning = status === 'call' || status === 'partial-call';

  return (
    <div className={cn(
      "flex items-center gap-3 p-3 my-2 rounded-lg border text-sm font-mono transition-all",
      isRunning
        ? "bg-zinc-900/50 border-zinc-800 text-zinc-400" 
        : "bg-emerald-950/20 border-emerald-900/50 text-emerald-400"
    )}>
      <div className="flex items-center justify-center w-6 h-6 rounded bg-zinc-800/50 shrink-0">
        {isRunning ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
        )}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold uppercase text-[10px] tracking-wider opacity-70">
            {tool.replace(/_/g, ' ')}
          </span>
        </div>
        {filePath && (
          <div className="text-[11px] opacity-60 truncate mt-0.5">
            {filePath}
          </div>
        )}
      </div>
    </div>
  );
}