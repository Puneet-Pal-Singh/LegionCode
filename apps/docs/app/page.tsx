'use client';

import React from 'react';
import Link from 'next/link';
import { 
  BookOpen, 
  Cpu, 
  Sliders, 
  Terminal, 
  ArrowRight, 
  Github, 
  Sparkles, 
  ShieldCheck, 
  Zap, 
  GitFork 
} from 'lucide-react';
import { DocsCard } from '@/components/DocsCard';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-black text-[#e4e4e7] font-sans selection:bg-zinc-800 selection:text-white relative overflow-hidden flex flex-col justify-between" id="home-viewport">
      
      {/* Decorative Grid Mesh overlay & Radial Ambient light */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#27272a_1px,transparent_1px),linear-gradient(to_bottom,#27272a_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] opacity-15" />
      <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[350px] bg-zinc-900/10 blur-[130px] rounded-full pointer-events-none" />

      {/* Top Header/Navbar */}
      <header className="relative z-10 w-full max-w-7xl mx-auto h-16 px-4 sm:px-6 lg:px-8 flex items-center justify-between border-b border-white/5" id="home-header">
        <div className="flex items-center gap-1.5">
          <svg
            className="w-5 h-5 text-white mr-0.5 opacity-90"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M 7,17 L 2,12 L 7,7" />
            <line x1="12" y1="3" x2="12" y2="21" />
            <path d="M 17,7 L 22,12 L 17,17" />
          </svg>
          <div className="flex flex-col">
            <span className="font-semibold text-white text-sm tracking-tight leading-none">
              LegionCode
            </span>
            <span className="text-[9px] font-mono tracking-widest text-[#e4e4e7]/40 uppercase mt-0.5">Docs Portal</span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          <a 
            href="https://github.com/Puneet-Pal-Singh/LegionCode" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors py-1 px-2.5 rounded bg-zinc-900 border border-white/5"
          >
            <Github className="w-3.5 h-3.5" />
            <span>GitHub</span>
          </a>
        </div>
      </header>

      {/* Hero Section Container */}
      <main className="relative z-10 w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24 flex flex-col items-center text-center grow justify-center">
        
        {/* Release Tag */}
        <div className="inline-flex items-center gap-1.5 px-3 py-1 mb-6 rounded-full text-[10px] sm:text-xs font-bold bg-violet-955/20 border border-violet-900/30 text-violet-300 uppercase tracking-widest animate-pulse">
          <Sparkles className="w-3 h-3" />
          <span>Public Alpha Portal v0.0.1</span>
        </div>

        {/* Master Headline */}
        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-white font-sans max-w-3xl leading-[1.1] mb-6">
          The Web-Native <span className="text-zinc-300 font-light italic">Coding-Agent</span> Workspace
        </h1>

        {/* Subtitle */}
        <p className="text-sm sm:text-base md:text-lg text-zinc-400 max-w-2xl leading-relaxed mb-8 font-sans font-light">
          LegionCode provides isolated cloud sandboxes, multi-provider LLM routing, and structured file diff reviews. Connect repositories, trigger complex tasks, and authorize code changes in real-time.
        </p>

        {/* Call to Actions (CTAs) */}
        <div className="flex flex-col sm:flex-row gap-3.5 mb-16 justify-center w-full max-w-md">
          <Link 
            href="/docs/introduction"
            className="flex items-center justify-center gap-1.5 bg-white hover:bg-zinc-250 text-black font-semibold px-6 py-3 rounded-md text-sm transition-all duration-150 leading-none shadow shadow-black group"
          >
            <span>Browse Documentation</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
          </Link>
          <Link 
            href="/docs/quickstart"
            className="flex items-center justify-center gap-1.5 bg-black hover:bg-zinc-950 text-zinc-300 hover:text-white font-mono px-6 py-3 rounded-md text-xs border border-white/10 hover:border-white/25 transition-all duration-150"
          >
            <Terminal className="w-3.5 h-3.5 text-zinc-500" />
            <span>$ pnpm dev</span>
          </Link>
        </div>

        {/* Bento Grid Concept Highlights */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left w-full max-w-4xl" id="capabilities-grid">
          <DocsCard
            title="Isolated Execution"
            description="Run coding agents inside secure, ephemeral Cloudflare execution environments, keeping your client and server configurations safe."
            icon={<Cpu className="w-5 h-5 text-zinc-400" />}
          />
          <DocsCard
            title="Model Freedom (BYOK)"
            description="Supports OpenRouter, OpenAI, Groq, Anthropic, Google Gemini, and custom endpoints with zero added markup or fees."
            icon={<Sliders className="w-5 h-5 text-zinc-400" />}
          />
          <DocsCard
            title="Review-Based Workflow"
            description="Examine file modifications line-by-line prior to checkout. Accept, reject, or prompt the model to re-iterate on changes."
            icon={<BookOpen className="w-5 h-5 text-zinc-400" />}
          />
        </div>

      </main>

      {/* Footer bar */}
      <footer className="relative z-10 w-full py-6 border-t border-white/5 text-center text-xs text-zinc-550 font-mono" id="home-footer">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>&copy; {new Date().getFullYear()} LegionCode workspace. Released under MIT License.</span>
          <div className="flex gap-4">
            <a href="https://github.com/Puneet-Pal-Singh/LegionCode" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-300">GitHub</a>
            <span>&bull;</span>
            <Link href="/docs/introduction" className="hover:text-zinc-300">Documentation</Link>
          </div>
        </div>
      </footer>

    </div>
  );
}
