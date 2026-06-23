"use client";

import React from "react";
import { ArrowUpRight, Terminal } from "lucide-react";
import Link from "next/link";

export default function SurfacesSection() {
  return (
    <section
      id="workspaces"
      className="py-28 px-6 max-w-7xl mx-auto border-t border-white/5 relative"
    >
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-900/10 via-transparent to-transparent -z-10" />

      <div className="text-center mb-16">
        <h2 className="font-display text-3xl sm:text-4xl font-medium tracking-tight text-white mb-4">
          The same agent workspace, across every surface.
        </h2>
        <p className="text-zinc-500 text-xs sm:text-sm font-light max-w-xl mx-auto leading-relaxed">
          Start with Cloud Agents today. Desktop and CLI are planned surfaces
          built on the same LegionCode harness.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto items-stretch">
        {/* Card 1: Cloud Agents - HIGHLIGHTED ACTIVE CARD */}
        <div className="p-8 rounded-2xl bg-zinc-950/40 border border-white/10 hover:border-cyan-500/25 transition-all duration-300 flex flex-col justify-between relative group shadow-[0_0_50px_-12px_rgba(6,182,212,0.05)]">
          <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div className="w-12 h-12 rounded-xl bg-cyan-500/[0.05] border border-cyan-500/15 flex items-center justify-center text-cyan-400 group-hover:border-cyan-400/35 transition-all duration-300">
              <svg
                className="w-5 h-5 stroke-[1.8]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17.5 19A3.5 3.5 0 0 0 21 15.5c0-1.72-1.32-3.14-3-3.46a6 6 0 0 0-11-2.04A4.5 4.5 0 0 0 7 19z" />
              </svg>
            </div>
            <div className="sm:absolute sm:top-5 sm:right-5 px-3 py-1 rounded-full bg-cyan-500/[0.08] border border-cyan-500/20 text-[10px] text-cyan-400 font-mono tracking-tight flex items-center gap-1.5 select-none font-medium animate-pulse w-fit">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
              <span>Available in private alpha</span>
            </div>
          </div>
          <div>
            <h3 className="text-white font-semibold text-xl mb-3 tracking-tight">
              Cloud Agents
            </h3>
            <p className="text-zinc-400 text-sm font-light leading-relaxed mb-8">
              Run parallel coding agents in isolated cloud workspaces, review
              diffs, and merge only what you approve.
            </p>
          </div>
          <Link
            href="/cloud"
            className="inline-flex items-center gap-2 bg-white hover:bg-neutral-100 text-black px-4.5 py-2.5 rounded-lg text-xs font-semibold tracking-tight transition-all duration-200 mt-auto w-fit group/btn whitespace-nowrap"
          >
            <span>Request Cloud Access</span>
            <ArrowUpRight className="w-3.5 h-3.5 stroke-[2.5] group-hover/btn:translate-x-0.5 group-hover/btn:-translate-y-0.5 transition-transform" />
          </Link>
        </div>

        {/* Card 2: Desktop - QUIETER MUTED PREVIEW */}
        <div className="p-8 rounded-2xl bg-zinc-950/10 border border-white/5 opacity-[0.72] hover:bg-zinc-950/20 transition-all duration-300 flex flex-col justify-between relative group">
          <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div className="w-12 h-12 rounded-xl bg-white/[0.01] border border-white/5 flex items-center justify-center text-zinc-400">
              <svg
                className="w-5 h-5 stroke-[1.5]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <div className="sm:absolute sm:top-5 sm:right-5 px-3 py-1 rounded-full bg-white/[0.02] border border-white/5 text-[10px] text-zinc-400 font-mono tracking-tight select-none w-fit">
              Coming soon
            </div>
          </div>
          <div>
            <h3 className="text-zinc-300 font-medium text-lg mb-3 tracking-tight">
              Desktop
            </h3>
            <p className="text-zinc-400 text-sm font-light leading-relaxed mb-8">
              A local-first workspace for running LegionCode agents on your
              machine.
            </p>
          </div>
          <div className="text-[10px] text-zinc-550 font-mono select-none mt-auto">
            &mdash;
          </div>
        </div>

        {/* Card 3: CLI - QUIETER MUTED PREVIEW */}
        <div className="p-8 rounded-2xl bg-zinc-950/10 border border-white/5 opacity-[0.72] hover:bg-zinc-950/20 transition-all duration-300 flex flex-col justify-between relative group md:col-span-2 lg:col-span-1">
          <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div className="w-12 h-12 rounded-xl bg-white/[0.01] border border-white/5 flex items-center justify-center text-zinc-400">
              <Terminal className="w-5 h-5 stroke-[1.5]" />
            </div>
            <div className="sm:absolute sm:top-5 sm:right-5 px-3 py-1 rounded-full bg-white/[0.02] border border-white/5 text-[10px] text-zinc-400 font-mono tracking-tight select-none w-fit">
              Coming soon
            </div>
          </div>
          <div>
            <h3 className="text-zinc-300 font-medium text-lg mb-3 tracking-tight">
              CLI
            </h3>
            <p className="text-zinc-400 text-sm font-light leading-relaxed mb-8">
              Scriptable agent runs for automation and terminal workflows.
            </p>
          </div>
          <div className="text-[10px] text-zinc-550 font-mono select-none mt-auto">
            &mdash;
          </div>
        </div>
      </div>
    </section>
  );
}
