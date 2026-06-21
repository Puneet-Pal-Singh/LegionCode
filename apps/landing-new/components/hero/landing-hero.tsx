'use client';

import React from 'react';
import { motion } from 'motion/react';
import { Terminal, ArrowUpRight, Github } from 'lucide-react';
import Link from 'next/link';

export default function LandingHero() {
  return (
    <section className="relative px-6 pt-16 md:pt-28 pb-16 overflow-hidden">
      
      {/* Subtle Background Radial Depth */}
      <div className="absolute inset-x-0 top-0 h-[400px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900/40 via-transparent to-transparent -z-10 pointer-events-none" />

      {/* Ambient floating technological indicators in Monochrome */}
      <div className="absolute top-[15%] left-[6%] hidden xl:block pointer-events-none select-none">
        <motion.div 
          animate={{ y: [0, -8, 0], rotate: [0, 1, 0] }}
          transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
          className="w-14 h-14 rounded-2xl bg-white/5 backdrop-blur-xl border border-white/10 shadow-2xl flex items-center justify-center text-zinc-400 hover:text-white transition-all cursor-pointer"
        >
          {/* Minimal Claude-like Asterisk */}
          <svg className="w-6 h-6 stroke-current" viewBox="0 0 24 24" fill="none" strokeWidth="1.5">
            <path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" />
          </svg>
        </motion.div>
      </div>

      <div className="absolute top-[28%] right-[8%] hidden xl:block pointer-events-none select-none">
        <motion.div 
          animate={{ y: [0, 8, 0], rotate: [0, -1, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
          className="w-14 h-14 rounded-2xl bg-white/5 backdrop-blur-xl border border-white/10 shadow-2xl flex items-center justify-center text-zinc-400 hover:text-white transition-all cursor-pointer"
        >
          {/* Minimal OpenAI style pattern */}
          <svg className="w-6 h-6 stroke-current stroke-[1.2]" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2a4 4 0 0 0-4 4M12 2a4 4 0 0 1 4 4M8 6a4 4 0 0 0-4 4M16 6a4 4 0 0 1 4 4M4 10a4 4 0 0 0 4 4M20 10a4 4 0 0 1-4 4M8 14a4 4 0 0 0 4 4M16 14a4 4 0 0 1-4 4" />
          </svg>
        </motion.div>
      </div>

      <div className="absolute bottom-[25%] left-[5%] hidden xl:block pointer-events-none select-none">
        <motion.div 
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
          className="w-14 h-14 rounded-2xl bg-white/5 backdrop-blur-xl border border-white/15 shadow-2xl flex items-center justify-center text-zinc-400 hover:text-white transition-all cursor-pointer"
        >
          <Terminal className="w-5 h-5 text-zinc-300" />
        </motion.div>
      </div>

      <div className="absolute bottom-[35%] right-[6%] hidden xl:block pointer-events-none select-none">
        <motion.div 
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 1.5 }}
          className="w-14 h-14 rounded-2xl bg-white/5 backdrop-blur-xl border border-white/15 shadow-2xl flex items-center justify-center text-zinc-400 hover:text-white transition-all cursor-pointer"
        >
          <div className="font-mono text-xs font-semibold select-none text-zinc-300">&lt;/&gt;</div>
        </motion.div>
      </div>

      {/* Hero Copy Content */}
      <div className="max-w-4xl mx-auto text-center flex flex-col items-center">
        
        {/* Main Statement Title */}
        <h1 className="font-display text-4xl sm:text-5xl md:text-6xl lg:text-[68px] font-medium tracking-tight text-white leading-[1.1] mb-6 max-w-3xl animate-in fade-in slide-in-from-bottom-3 duration-500">
          The open-source multi-agent coding workspace.
        </h1>

        {/* Tagline Paragraph */}
        <p className="text-zinc-400 text-base sm:text-lg md:text-xl font-light leading-relaxed max-w-2xl mb-10 animate-in fade-in slide-in-from-bottom-4 duration-600">
          Connect a repo, launch parallel coding agents in isolated worktrees, and review every diff before it reaches your main branch.
        </p>

        {/* Action CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4 w-full sm:w-auto animate-in fade-in slide-in-from-bottom-5 duration-700">
          <Link 
            href="/agents" 
            className="w-full sm:w-auto flex items-center justify-center gap-2.5 bg-white text-black hover:bg-neutral-100 px-8 py-3.5 rounded-xl font-medium tracking-tight shadow-[0_0_30px_rgba(255,255,255,0.25)] hover:shadow-[0_0_50px_rgba(255,255,255,0.4)] transition-all duration-300 transform hover:-translate-y-0.5 whitespace-nowrap"
          >
            <span>Open Cloud Agents</span>
            <ArrowUpRight className="w-4 h-4 text-black stroke-[2.5]" />
          </Link>
          
          <a 
            href="https://github.com/Puneet-Pal-Singh/LegionCode"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto flex items-center justify-center gap-2.5 text-white hover:bg-white/10 border border-white/20 bg-white/5 backdrop-blur-md px-8 py-3.5 rounded-xl font-medium tracking-tight transition-all duration-300 transform hover:-translate-y-0.5 shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:shadow-[0_0_25px_rgba(255,255,255,0.15)] whitespace-nowrap"
          >
            <Github className="w-4 h-4 text-zinc-100" />
            <span>Star on GitHub</span>
          </a>
        </div>

        {/* Minimal Open Source Badging under CTAs */}
        <div className="text-[11px] font-mono text-zinc-500 mb-16 flex items-center gap-1.5 select-none animate-in fade-in duration-1000">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>Free, permissive, and open-source under the MIT License.</span>
        </div>
      </div>

    </section>
  );
}
