'use client';

import React from 'react';
import { ArrowRight, GitMerge, GitPullRequest, ChevronDown, Lock, RotateCw, Settings } from 'lucide-react';

function DesktopWallpaperBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none -z-0">
      {/* Base warm painterly color fill */}
      <div className="absolute inset-0 bg-[#8c9282]" />

      {/* High Quality Painterly Oil Landscape SVG (matching impressionist wallpaper) */}
      <svg
        className="absolute inset-0 w-full h-full object-cover opacity-90 scale-[1.02]"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1200 800"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ede6d8" />
            <stop offset="35%" stopColor="#ded6c5" />
            <stop offset="65%" stopColor="#c5ccbe" />
            <stop offset="100%" stopColor="#9ea797" />
          </linearGradient>
          <linearGradient id="cloudGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f5f0e6" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#ded6c5" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hillFar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#969e8f" />
            <stop offset="100%" stopColor="#757e6e" />
          </linearGradient>
          <linearGradient id="hillMid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7f8877" />
            <stop offset="100%" stopColor="#5d6655" />
          </linearGradient>
          <linearGradient id="hillNear" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5e6655" />
            <stop offset="100%" stopColor="#3d4435" />
          </linearGradient>
          <radialGradient id="sunSoft" cx="60%" cy="25%" r="60%">
            <stop offset="0%" stopColor="#fffcf2" stopOpacity="0.7" />
            <stop offset="50%" stopColor="#ede6d8" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#ede6d8" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Sky Base */}
        <rect width="1200" height="800" fill="url(#skyGrad)" />
        <rect width="1200" height="800" fill="url(#sunSoft)" />

        {/* Painterly Clouds */}
        <path d="M-100 240 Q 250 160 600 220 T 1300 180 V 0 H -100 Z" fill="url(#cloudGrad)" />
        <path d="M-100 320 Q 350 250 850 310 T 1300 270 V 0 H -100 Z" fill="#e8e1d3" fillOpacity="0.4" />

        {/* Far Distant Mountain Range */}
        <path d="M-50 460 C 200 380, 450 470, 700 410 C 950 350, 1100 430, 1250 400 V 800 H -50 Z" fill="url(#hillFar)" />

        {/* Mid-ground Rolling Hills */}
        <path d="M-50 530 C 180 470, 420 540, 680 480 C 920 420, 1120 500, 1250 470 V 800 H -50 Z" fill="url(#hillMid)" />

        {/* Foreground Painterly Ridges */}
        <path d="M-50 620 C 250 560, 550 640, 850 570 C 1050 520, 1180 610, 1250 580 V 800 H -50 Z" fill="url(#hillNear)" />
        <path d="M-50 710 C 350 660, 750 720, 1250 660 V 800 H -50 Z" fill="#2d3327" opacity="0.9" />
      </svg>

      {/* Subtle Painterly Lighting Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-white/10 pointer-events-none" />
    </div>
  );
}

export default function CloudSection() {
  return (
    <section id="cloud" className="relative overflow-hidden border-t border-white/5 bg-black px-4 py-[84px] select-none sm:px-6 sm:py-28 lg:py-36">
      {/* Subtle background radial glow */}
      <div className="absolute top-1/2 left-1/3 -translate-y-1/2 w-[500px] h-[500px] bg-white/[0.015] rounded-full blur-[160px] pointer-events-none" />

      <div className="max-w-7xl mx-auto">
        <div className="grid items-center gap-8 sm:gap-10 lg:grid-cols-12 lg:gap-10 xl:gap-14">
          
          {/* PRODUCT VISUAL: Desktop Wallpaper Canvas & App Window (Order 2 on mobile, Order 1 on lg desktop) */}
          <div className="w-full order-2 lg:order-1 lg:col-span-7 min-w-0">
            {/* Wallpaper Canvas with top/left padding and right/bottom bleed for immersion */}
            <div className="relative rounded-2xl lg:rounded-3xl border border-white/15 overflow-hidden pl-3 pt-3 sm:pl-6 sm:pt-6 lg:pl-8 lg:pt-8 pr-0 pb-0 shadow-2xl bg-[#1a1c18] group">
              
              {/* Desktop Wallpaper Background */}
              <DesktopWallpaperBackground />

              {/* Floating Inner Application Window - Immersed into right & bottom edges */}
              <div className="relative z-10 rounded-tl-xl sm:rounded-tl-2xl rounded-tr-none rounded-br-none rounded-bl-none bg-zinc-950/95 backdrop-blur-2xl border-t border-l border-white/10 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.95)] overflow-hidden transition-transform duration-300 w-full">
                  
                  {/* Window Header Bar with vivid status controls */}
                  <div className="px-3 sm:px-4 py-2 sm:py-2.5 bg-zinc-900/90 border-b border-white/5 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 w-16">
                      <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f56] opacity-90 hover:opacity-100 transition-opacity" />
                      <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e] opacity-90 hover:opacity-100 transition-opacity" />
                      <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f] opacity-90 hover:opacity-100 transition-opacity" />
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs font-sans text-zinc-400 bg-zinc-950/90 px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-lg border border-white/10 w-full max-w-xs sm:max-w-md">
                      <Lock className="w-3 h-3 text-zinc-400 shrink-0" />
                      <span className="truncate text-zinc-200 font-mono text-[10px] sm:text-[11px]">legioncode.dev/agents</span>
                      <RotateCw className="w-3 h-3 text-zinc-400 shrink-0" />
                    </div>
                    <div className="w-16" />
                  </div>

                {/* Window Body: Sidebar (desktop only) + Main Chat Content (Taller height for immersion) */}
                <div className="grid grid-cols-1 md:grid-cols-12 h-[460px] sm:h-[530px] md:h-[620px] overflow-hidden">
                  
                  {/* Sidebar: Parallel Threads List (Hidden on mobile, visible on desktop) */}
                  <div className="hidden md:flex md:col-span-4 border-r border-white/5 bg-zinc-950/60 p-3 flex-col justify-between h-full overflow-y-auto">
                    <div>
                      <div className="text-[10px] font-mono text-zinc-400 tracking-wider uppercase px-2 py-1.5 mb-1 flex items-center justify-between select-none">
                        <span>Active Threads</span>
                        <span className="text-zinc-500 font-medium">3/150</span>
                      </div>

                      <div className="space-y-1">
                        {/* Thread 1 - Selected / Review state */}
                        <div className="group p-2.5 rounded-lg bg-white/[0.06] border border-white/10 cursor-pointer transition-all">
                          <div className="flex items-center gap-2 truncate text-xs font-medium text-white mb-1">
                            <GitPullRequest className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                            <span className="truncate">Build cloud landing section</span>
                          </div>
                          <div className="text-[10px] font-mono text-zinc-400 truncate pl-5.5">
                            legioncode / cloud-section
                          </div>
                        </div>

                        {/* Thread 2 - Running / Active state */}
                        <div className="group p-2.5 rounded-lg hover:bg-white/[0.03] border border-transparent cursor-pointer transition-all">
                          <div className="flex items-center gap-2 truncate text-xs font-medium text-zinc-200 mb-1">
                            <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0 shadow-[0_0_8px_rgba(96,165,250,0.5)]" />
                            <span className="truncate group-hover:text-white transition-colors">Improve onboarding</span>
                          </div>
                          <div className="text-[10px] font-mono text-zinc-400 truncate pl-4">
                            legioncode / onboarding-v2
                          </div>
                        </div>

                        {/* Thread 3 - Active state */}
                        <div className="group p-2.5 rounded-lg hover:bg-white/[0.03] border border-transparent cursor-pointer transition-all">
                          <div className="flex items-center gap-2 truncate text-xs font-medium text-zinc-200 mb-1">
                            <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0 shadow-[0_0_8px_rgba(96,165,250,0.5)]" />
                            <span className="truncate group-hover:text-white transition-colors">Update documentation</span>
                          </div>
                          <div className="text-[10px] font-mono text-zinc-400 truncate pl-4">
                            docs / api-spec-sync
                          </div>
                        </div>

                        {/* Thread 4 - Merged state */}
                        <div className="group p-2.5 rounded-lg hover:bg-white/[0.03] border border-transparent cursor-pointer transition-all opacity-80">
                          <div className="flex items-center gap-2 truncate text-xs font-medium text-zinc-300 mb-1">
                            <GitMerge className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                            <span className="truncate group-hover:text-zinc-100 transition-colors">Auth token rotation</span>
                          </div>
                          <div className="text-[10px] font-mono text-zinc-500 truncate pl-5.5">
                            security / token-expiry
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Sidebar Footer with Settings Button */}
                    <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between px-1">
                      <button className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors py-1 px-1.5 rounded hover:bg-white/5 font-sans cursor-pointer">
                        <Settings className="w-3.5 h-3.5 text-zinc-400" />
                        <span>Settings</span>
                      </button>
                    </div>
                  </div>

                  {/* Main Task Detail Window (Full width on mobile, 8-cols on desktop) */}
                  <div className="col-span-1 md:col-span-8 p-3 sm:p-4 flex flex-col justify-between bg-zinc-950 h-full overflow-hidden">
                    {/* Scrollable Messages & Diff Area */}
                    <div className="flex-1 overflow-y-auto pr-1 min-h-0 space-y-2.5 sm:space-y-3">
                      {/* Task Title Header */}
                      <div className="flex items-center justify-between mb-2 text-xs font-mono pb-2 border-b border-white/5 sticky top-0 bg-zinc-950 z-10 pt-0.5">
                        <span className="text-white font-medium truncate text-[11px] sm:text-xs">
                          Build cloud landing section
                        </span>
                      </div>

                      {/* User Prompt Message (Right Side Chat Bubble) */}
                      <div className="flex justify-end mb-2.5 sm:mb-3">
                        <div className="max-w-[92%] sm:max-w-[85%] bg-zinc-800/90 border border-white/10 rounded-xl sm:rounded-2xl rounded-tr-xs p-2.5 sm:p-3 text-[11px] sm:text-xs text-zinc-200 font-mono leading-relaxed shadow-sm">
                          Add a new LegionCode Cloud section to the landing page. Show parallel agent threads, isolated sandboxes, and a clear call to request cloud access.
                        </div>
                      </div>

                      {/* Execution Steps with Always-Vibrant Colors */}
                      <div className="space-y-1 sm:space-y-1.5 text-[10px] sm:text-[11px] font-mono mb-2.5 sm:mb-3">
                        <div className="text-[11px] sm:text-xs text-zinc-400 font-mono mb-1.5 sm:mb-2 px-0.5 flex items-center gap-1.5 cursor-pointer hover:text-zinc-300 transition-colors">
                          <span>Worked for 1m 42s</span>
                          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                        </div>

                        <div className="group flex items-center justify-between text-zinc-300 py-0.5 px-2 rounded bg-white/[0.02] hover:bg-white/[0.05] transition-colors">
                          <span className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                            <span className="text-zinc-500 shrink-0">− read</span>
                            <span className="text-zinc-200 truncate">apps/web/components/landing/cloud-section.tsx</span>
                          </span>
                          <span className="text-zinc-400 text-[9px] sm:text-[10px] shrink-0 ml-1">inspect</span>
                        </div>

                        <div className="group flex items-center justify-between text-zinc-300 py-0.5 px-2 rounded bg-white/[0.02] hover:bg-white/[0.05] transition-colors">
                          <span className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                            <span className="text-zinc-500 shrink-0">− grep</span>
                            <span className="text-zinc-200 truncate">CloudSection</span>
                          </span>
                          <span className="text-zinc-400 text-[9px] sm:text-[10px] shrink-0 ml-1">6 matches</span>
                        </div>

                        <div className="group flex items-center justify-between text-zinc-300 py-0.5 px-2 rounded bg-white/[0.02] hover:bg-white/[0.05] transition-colors">
                          <span className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                            <span className="text-zinc-500 shrink-0">− edit</span>
                            <span className="text-zinc-200 truncate">apps/web/components/landing/cloud-section.tsx</span>
                          </span>
                          <span className="text-[9px] sm:text-[10px] font-mono space-x-1 shrink-0 ml-1">
                            <span className="text-emerald-400 font-medium">+38</span>
                            <span className="text-red-400 font-medium">-9</span>
                          </span>
                        </div>

                        <div className="group flex items-center justify-between text-zinc-300 py-0.5 px-2 rounded bg-white/[0.02] hover:bg-white/[0.05] transition-colors">
                          <span className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                            <span className="text-zinc-500 shrink-0">− run</span>
                            <span className="text-zinc-200 truncate">pnpm test landing</span>
                          </span>
                          <span className="text-emerald-400 font-medium text-[9px] sm:text-[10px] shrink-0 ml-1">24 passed</span>
                        </div>
                      </div>

                      {/* Agent Completion Summary */}
                      <div className="mb-2.5 text-[11px] sm:text-xs font-mono leading-relaxed text-zinc-300">
                        Added the LegionCode Cloud section with parallel thread activity, isolated task execution, and a cloud access CTA. Verified all 24 tests pass.
                      </div>

                      {/* Diff Preview with Always-Vibrant Colors */}
                      <div className="rounded-lg border border-white/10 bg-black overflow-hidden mb-2">
                        <div className="px-2.5 sm:px-3 py-1.5 bg-zinc-900/80 border-b border-white/5 flex items-center justify-between text-[10px] sm:text-[11px] font-mono text-zinc-400">
                          <span className="truncate mr-2">apps/web/components/landing/cloud-section.tsx</span>
                          <span className="text-[9px] sm:text-[10px] font-mono space-x-1 shrink-0">
                            <span className="text-emerald-400 font-medium">+38</span>
                            <span className="text-red-400 font-medium">-9</span>
                          </span>
                        </div>
                        <div className="p-2 sm:p-2.5 font-mono text-[10px] sm:text-[11px] leading-relaxed text-zinc-300 overflow-x-auto space-y-0.5 sm:space-y-1">
                          <div className="bg-red-500/15 text-red-300 px-1.5 py-0.5 rounded flex items-center gap-2">
                            <span className="text-red-400 font-bold">-</span>
                            <span>&lt;section className=&quot;cloud-placeholder&quot; /&gt;</span>
                          </div>
                          <div className="text-zinc-600 py-0.5"> </div>
                          <div className="bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 rounded flex items-center gap-2">
                            <span className="text-emerald-400 font-bold">+</span>
                            <span>&lt;CloudSection</span>
                          </div>
                          <div className="bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 rounded pl-4 sm:pl-5 flex items-center gap-2">
                            <span className="text-emerald-400 font-bold">+</span>
                            <span>title=&quot;Run agents in parallel.&quot;</span>
                          </div>
                          <div className="bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 rounded pl-4 sm:pl-5 flex items-center gap-2">
                            <span className="text-emerald-400 font-bold">+</span>
                            <span>description=&quot;Keep every task isolated.&quot;</span>
                          </div>
                          <div className="bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 rounded pl-4 sm:pl-5 flex items-center gap-2">
                            <span className="text-emerald-400 font-bold">+</span>
                            <span>showActiveThreads</span>
                          </div>
                          <div className="bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 rounded flex items-center gap-2">
                            <span className="text-emerald-400 font-bold">+</span>
                            <span>/&gt;</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Interactive Prompt / Chat Box (Pinned in place at bottom) */}
                    <div className="shrink-0 pt-1.5 sm:pt-2">
                      <div className="rounded-lg sm:rounded-xl border border-white/10 bg-zinc-900/90 p-2 sm:p-2.5 font-mono text-xs shadow-lg backdrop-blur-md">
                        <div className="text-zinc-500 mb-1.5 sm:mb-2 text-[10px] sm:text-xs truncate">
                          Ask LegionCode anything, @ to add files, / for commands...
                        </div>
                        <div className="flex items-center justify-between pt-0.5">
                          <div className="flex items-center gap-1.5">
                            <div className="px-2 py-0.5 rounded border border-white/10 bg-white/5 text-[9px] sm:text-[10px] font-mono flex items-center gap-1 cursor-pointer hover:bg-white/10 transition-colors">
                              <span className="text-zinc-200 font-medium">GPT 5.6 Sol</span>
                              <span className="text-zinc-500">High</span>
                              <ChevronDown className="w-3 h-3 text-zinc-400 ml-0.5" />
                            </div>
                          </div>
                          <div className="w-5 h-5 sm:w-6 sm:h-6 rounded bg-white text-black flex items-center justify-center text-[10px] sm:text-xs font-bold shadow">
                            ↵
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                </div>

              </div>
            </div>
          </div>

          {/* TEXT CONTENT: Copy & CTA (Order 1 on mobile above visual, Order 2 on lg desktop) */}
          <div className="flex flex-col justify-center order-1 lg:order-2 lg:col-span-5 w-full min-w-0">
            
            {/* Eyebrow */}
            <div className="text-[10px] sm:text-[11px] font-mono tracking-wider text-zinc-500 uppercase mb-2 font-semibold">
              LEGIONCODE CLOUD
            </div>

            {/* Headline with clean 2-line break on all breakpoints */}
            <h2 className="font-display text-xl sm:text-2xl md:text-3xl lg:text-3xl xl:text-[34px] font-medium tracking-tight text-white leading-tight sm:leading-snug mb-2.5 sm:mb-3.5 break-words">
              Run agents in parallel.<br />Keep every task isolated.
            </h2>

            {/* Body Copy */}
            <div className="mb-4 min-w-0 max-w-md text-zinc-400 sm:mb-5 lg:mb-6 lg:max-w-lg">
              <p className="break-words text-sm font-light leading-relaxed text-zinc-400 md:text-base">
                Agents get their own cloud computers to build, test, and complete tasks end to end for you to review.
              </p>
            </div>

            {/* CTA Button */}
            <div>
              <a
                href="https://github.com/Puneet-Pal-Singh/LegionCode"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 rounded-full bg-white text-black hover:bg-zinc-200 text-[11px] sm:text-xs font-semibold tracking-tight transition-all duration-300 transform hover:-translate-y-0.5 shadow-md shadow-white/5 cursor-pointer"
              >
                <span>Request Cloud Access</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </a>
            </div>

          </div>

        </div>
      </div>
    </section>
  );
}
