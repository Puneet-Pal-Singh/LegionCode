'use client';

import React from 'react';

export default function Footer() {
  return (
    <footer className="bg-black pt-0 pb-12 relative mt-auto select-none overflow-hidden">
      {/* Ambient background glows for seamless blending */}
      <div className="absolute -top-16 left-1/2 -translate-x-1/2 w-[400px] h-[200px] bg-blue-500/[0.03] blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-0 left-1/4 w-[300px] h-[150px] bg-zinc-800/[0.04] blur-[80px] rounded-full pointer-events-none" />

      <div className="max-w-7xl mx-auto px-6 relative">

        {/* Legal status footer bar */}
        <div className="pt-8 border-t border-white/[0.05] flex flex-col md:flex-row items-center justify-between text-zinc-500 text-[10px] font-mono gap-4">
          <div className="flex items-center gap-3">
            <span className="text-zinc-650">© 2026 LegionCode. MIT License.</span>
          </div>
          <div className="flex items-center gap-4">
            <a 
              href="https://github.com/Puneet-Pal-Singh/LegionCode" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="hover:text-white transition-colors relative group py-1"
            >
              <span>GitHub</span>
              <span className="absolute bottom-0 left-0 w-full h-[1px] bg-white scale-x-0 group-hover:scale-x-100 transition-transform origin-left duration-200" />
            </a>
            <span className="text-zinc-800 select-none">·</span>
            <a 
              href="https://github.com/Puneet-Pal-Singh/LegionCode#readme" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="hover:text-white transition-colors relative group py-1"
            >
              <span>Docs</span>
              <span className="absolute bottom-0 left-0 w-full h-[1px] bg-white scale-x-0 group-hover:scale-x-100 transition-transform origin-left duration-200" />
            </a>
          </div>
        </div>

      </div>
    </footer>
  );
}
