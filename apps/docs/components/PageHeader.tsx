import React from "react";
import { Sparkles } from "lucide-react";

interface PageHeaderProps {
  title: string;
  description: string;
  category: string;
  status?: "alpha" | "beta" | "planned" | "draft";
}

export function PageHeader({
  title,
  description,
  category,
  status,
}: PageHeaderProps) {
  return (
    <header className="mb-8 pb-6 border-b border-white/5">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-zinc-500 text-[10px] font-mono tracking-wider uppercase">
          {category}
        </span>
        {status && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-violet-950/40 text-violet-300 border border-violet-850/50 uppercase tracking-widest">
            <Sparkles className="w-2.5 h-2.5 animate-pulse" />
            {status}
          </span>
        )}
      </div>
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-3">
        {title}
      </h1>
      <p className="text-sm sm:text-base text-zinc-400 font-sans leading-relaxed">
        {description}
      </p>
    </header>
  );
}
