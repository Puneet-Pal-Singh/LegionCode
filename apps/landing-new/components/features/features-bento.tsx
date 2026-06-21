'use client';

import React from 'react';
import { Terminal, Settings, CheckCircle2 } from 'lucide-react';

export default function FeaturesBento() {
  return (
    <section id="features" className="py-20 px-6 border-t border-white/5 bg-gradient-to-b from-[#060606]/30 via-transparent to-transparent relative">
      <div className="absolute top-1/2 left-1/3 w-96 h-96 bg-white/[0.02] rounded-full blur-[120px] pointer-events-none -translate-y-1/2" />

      <div className="max-w-7xl mx-auto">
        
        <div className="mb-16 max-w-2xl">
          <h2 className="font-display text-xs font-semibold tracking-widest text-zinc-400 uppercase mb-4">
            Core Principles
          </h2>
          <p className="font-display text-2xl sm:text-3xl font-medium tracking-tight text-white leading-tight">
            High-speed agent routing, full provider freedom, and integrated code review.
          </p>
        </div>

        {/* Bento-grid minimal features columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          
          {/* Feature card 1 */}
          <div className="p-8 rounded-2xl bg-white/[0.03] backdrop-blur-lg border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all duration-300 flex flex-col justify-between min-h-[16rem] lg:h-64 shadow-xl select-none">
            <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display font-medium text-white text-lg mb-2">Top Providers & Models</h3>
              <p className="text-zinc-400 text-xs sm:text-sm leading-relaxed font-light">
                Use custom agents and all the latest models from top inference providers like OpenRouter, Cloudflare AI Gateway, OpenCode Go, OpenAI, and Claude AI.
              </p>
            </div>
          </div>

          {/* Feature card 2 */}
          <div className="p-8 rounded-2xl bg-white/[0.03] backdrop-blur-lg border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all duration-300 flex flex-col justify-between min-h-[16rem] lg:h-64 shadow-xl select-none">
             <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display font-medium text-white text-lg mb-2">Custom Built Harness</h3>
              <p className="text-zinc-400 text-xs sm:text-sm leading-relaxed font-light">
                Work with a lightning-fast premium agent execution harness, custom-built from scratch for unbeatable performance and complete dependability.
              </p>
            </div>
          </div>

          {/* Feature card 3 */}
          <div className="p-8 rounded-2xl bg-white/[0.03] backdrop-blur-lg border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all duration-300 flex flex-col justify-between min-h-[16rem] lg:h-64 md:col-span-2 lg:col-span-1 shadow-xl select-none">
            <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white">
              <CheckCircle2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display font-medium text-white text-lg mb-2">Code Review & Sandboxes</h3>
              <p className="text-zinc-400 text-xs sm:text-sm leading-relaxed font-light">
                Run complex tasks in fully isolated sandboxed cloud agents, then review changes securely with our integrated code review and diff tracking tools.
              </p>
            </div>
          </div>

        </div>

      </div>
    </section>
  );
}
