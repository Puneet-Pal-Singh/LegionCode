'use client';

import React, { useState } from 'react';
import { 
  ChevronDown, 
  MoreHorizontal, 
  FileCode, 
  ExternalLink,
  Copy, 
  ThumbsUp, 
  ThumbsDown, 
  Share2, 
  Plus, 
  ArrowUp,
  Check
} from 'lucide-react';

export default function MobileHeroShowcase() {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<boolean | null>(null);

  const handleCopy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-lg mx-auto px-0 pb-12 pt-1 select-none overflow-hidden relative">
      
      {/* Outer Container with right-side peek / tablet merge */}
      <div className="relative pl-3 sm:pl-5 pr-0 w-full">
        
        {/* Ambient Glow */}
        <div className="absolute top-1/3 right-0 w-80 h-80 bg-blue-500/10 blur-[110px] pointer-events-none" />

        {/* Tablet-Sized Window Merged into Right Side (Smooth bottom fade with clear diff & visible buttons) */}
        <div className="relative bg-[#0d0e12] text-zinc-300 rounded-tl-2xl sm:rounded-tl-3xl rounded-tr-none rounded-b-none p-4 sm:p-5 shadow-[0_30px_70px_-15px_rgba(0,0,0,0.95)] border-t border-l border-b-0 border-r-0 border-white/10 w-[114%] sm:w-[120%] font-sans overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,rgba(0,0,0,0.85)_90%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_75%,rgba(0,0,0,0.85)_90%,transparent_100%)]">
          
          {/* Subtle top reflection line */}
          <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-white/20 via-white/10 to-transparent" />

          {/* Window Header */}
          <div className="flex items-center justify-between pb-3 border-b border-white/5 mb-3.5 relative z-10">
            <div className="flex items-center gap-2">
              <span className="text-zinc-300 font-medium text-xs tracking-tight">
                Fix dashboard hero
              </span>
            </div>

            <button 
              type="button" 
              aria-label="More options"
              className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 mr-6"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>

          {/* User Prompt Bubble */}
          <div className="relative z-10 mb-3.5 ml-auto mr-12 w-fit max-w-[78%]">
            <div className="whitespace-normal rounded-xl border border-white/[0.08] bg-[#181920] px-4 py-3 text-xs font-normal leading-relaxed text-zinc-200 shadow-sm">
              Fix the dashboard hero layout and loading state.
            </div>
          </div>

          {/* Worked for status */}
          <div className="flex items-center gap-1.5 text-zinc-400 font-mono text-[11px] mb-2.5 relative z-10">
            <span className="text-zinc-500">Worked for</span>
            <span className="text-zinc-300 font-medium">2m 30s</span>
            <ChevronDown className="w-3 h-3 text-zinc-500" />
          </div>

          {/* Agent Response Body */}
          <div className="space-y-2.5 text-xs text-zinc-300 leading-relaxed font-normal mb-6 sm:mb-8 max-w-[90%] relative z-10">
            <p>
              Done — I fixed the dashboard hero layout and updated the loading flow so the empty view no longer flashes before data finishes loading.
            </p>
            <p className="text-zinc-400 text-[11px]">
              I adjusted <code className="bg-white/5 border border-white/10 px-1 py-0.5 rounded text-zinc-200 font-mono text-[10px]">hero.tsx</code> for responsive alignment and updated <code className="bg-white/5 border border-white/10 px-1 py-0.5 rounded text-zinc-200 font-mono text-[10px]">first_run.tsx</code> to separate the loading and empty states.
            </p>
          </div>

          {/* Edited Files Diff Box (Cleanly visible with subtle balanced fade) */}
          <div className="border border-white/10 rounded-xl bg-[#14151c]/90 p-2.5 mb-3 font-mono text-xs max-w-[90%] relative z-10 shadow-sm opacity-80">
            <div className="flex items-center justify-between pb-2 border-b border-white/10 mb-2">
              <div className="flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5 text-zinc-300" />
                <span className="font-semibold text-zinc-200 text-[11px]">Edited 2 files</span>
                <span className="font-medium text-[10px] ml-1">
                  <span className="text-emerald-400 font-semibold">+23</span>{' '}
                  <span className="text-rose-400 font-semibold">-24</span>
                </span>
              </div>
              <button 
                type="button" 
                className="bg-white/10 border border-white/15 px-2 py-0.5 rounded text-[10px] font-medium text-zinc-200 flex items-center gap-1 pointer-events-none"
              >
                <span>Review</span>
                <ExternalLink className="w-2.5 h-2.5 text-zinc-400" />
              </button>
            </div>

            {/* File Rows (Crisp & clearly readable) */}
            <div className="flex items-center justify-between py-1 text-[11px] text-zinc-200">
              <span className="font-medium truncate mr-2">app/src/first_run.tsx</span>
              <div className="shrink-0">
                <span className="text-emerald-400 font-semibold">+23</span>{' '}
                <span className="text-rose-400 font-semibold">-16</span>
              </div>
            </div>
            <div className="flex items-center justify-between py-1 text-[11px] text-zinc-300">
              <span className="font-medium truncate mr-2">app/src/hero.tsx</span>
              <div className="shrink-0">
                <span className="text-emerald-400 font-semibold">+0</span>{' '}
                <span className="text-rose-400 font-semibold">-8</span>
              </div>
            </div>
          </div>

          {/* Action Buttons Row (Subtle fade, similar to the last diff row) */}
          <div className="flex items-center gap-3.5 text-zinc-200/90 mb-5 pt-1 relative z-10">
            <button 
              type="button" 
              onClick={handleCopy} 
              aria-label="Copy text"
              className="hover:text-white transition-colors p-1"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-300" />}
            </button>
            <button 
              type="button" 
              onClick={() => setLiked(liked === true ? null : true)} 
              aria-label="Thumbs up"
              className={`hover:text-white transition-colors p-1 ${liked === true ? 'text-emerald-400' : 'text-zinc-300'}`}
            >
              <ThumbsUp className="w-3.5 h-3.5" />
            </button>
            <button 
              type="button" 
              onClick={() => setLiked(liked === false ? null : false)} 
              aria-label="Thumbs down"
              className={`hover:text-white transition-colors p-1 ${liked === false ? 'text-rose-400' : 'text-zinc-300'}`}
            >
              <ThumbsDown className="w-3.5 h-3.5" />
            </button>
            <button 
              type="button" 
              aria-label="Share"
              className="hover:text-white transition-colors p-1 text-zinc-300"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
            <button 
              type="button" 
              aria-label="More"
              className="hover:text-white transition-colors p-1 text-zinc-300"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Subtle Bottom Gradient Fadeout (Below buttons) */}
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black via-black/40 to-transparent pointer-events-none z-10" />

        </div>

        {/* Detached Floating Chat Composer (Wider, Centered, and Squarish - Overlaying end of summary) */}
        <div className="absolute top-[55%] sm:top-[56%] -translate-y-1/2 left-1 right-1 sm:left-3 sm:right-3 z-30">
          <div className="bg-[#1c1d24]/95 backdrop-blur-2xl rounded-xl sm:rounded-2xl border border-white/25 p-3 sm:p-3.5 flex items-center justify-between shadow-[0_25px_60px_rgba(0,0,0,0.98)] ring-1 ring-white/15 hover:border-white/35 transition-all">
            <div className="flex items-center gap-2.5 text-zinc-400 flex-1 min-w-0 pl-0.5">
              <button 
                type="button" 
                aria-label="Add attachment"
                className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-300 hover:text-white transition-colors shrink-0"
              >
                <Plus className="w-4 h-4 stroke-[2]" />
              </button>
              <span className="text-xs sm:text-[13px] text-zinc-200 font-normal truncate">
                Ask LegionCode anything...
              </span>
            </div>
            
            <button 
              type="button"
              aria-label="Send message"
              className="w-8 h-8 rounded-lg bg-white text-black flex items-center justify-center shrink-0 shadow-md hover:bg-zinc-200 transition-transform active:scale-95 ml-2"
            >
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            </button>
          </div>
        </div>

      </div>

    </div>
  );
}
