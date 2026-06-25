'use client';

import React from 'react';

export default function AnnouncementBanner() {
  return (
    <div className="w-full bg-zinc-950/80 backdrop-blur border-b border-white/5 py-2.5 text-center px-4 relative z-50">
      <a 
        href="/cloud" 
        className="inline-flex items-center gap-2 group text-xs text-zinc-400 hover:text-white transition-colors tracking-tight font-mono"
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
        <span>Introducing LegionCode Cloud →</span>
      </a>
    </div>
  );
}
