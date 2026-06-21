'use client';

import React from 'react';
import { ArrowUpRight, Github } from 'lucide-react';
import Link from 'next/link';

export default function ExperienceLiftoff() {
  return (
    <section id="liftoff" className="pt-28 pb-12 px-6 bg-black relative border-t border-white/5 select-none overflow-hidden min-h-[450px] flex items-center">
      
      {/* Immersive 3D concentric radiating space starfield / galaxy */}
      <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center overflow-hidden">
        
        {/* Subtle bluish/cyan deep lighting glow */}
        <div className="absolute w-[60%] h-[60%] rounded-full bg-blue-500/5 mix-blend-screen blur-[120px] animate-pulse" />
        <div className="absolute w-[40%] h-[40%] rounded-full bg-sky-600/5 mix-blend-screen blur-[80px]" />
        
        {/* Custom SVG Particle vortex */}
        <svg className="w-[160%] h-[160%] md:w-[125%] md:h-[125%] absolute select-none opacity-45 animate-[spin_140s_linear_infinite]" viewBox="0 0 1000 1000" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="vortex-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
              <stop offset="60%" stopColor="#1d4ed8" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#000000" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="500" cy="500" r="480" fill="url(#vortex-glow)" opacity="0.15" />
          
          {/* Elegant, spiraling star patterns */}
          <circle cx="500" cy="500" r="80" stroke="#3b82f6" strokeWidth="1" strokeDasharray="3 16" opacity="0.45" />
          <circle cx="500" cy="500" r="140" stroke="#60a5fa" strokeWidth="1" strokeDasharray="2 24" opacity="0.35" />
          <circle cx="500" cy="550" r="210" stroke="#93c5fd" strokeWidth="0.8" strokeDasharray="1 28" opacity="0.25" className="origin-center transform rotate-45" />
          <circle cx="500" cy="500" r="280" stroke="#3b82f6" strokeWidth="1.2" strokeDasharray="4 32" opacity="0.3" />
          <circle cx="500" cy="450" r="350" stroke="#60a5fa" strokeWidth="1" strokeDasharray="2 36" opacity="0.2" className="origin-center transform -rotate-12" />
          <circle cx="500" cy="500" r="420" stroke="#93c5fd" strokeWidth="1.5" strokeDasharray="3 40" opacity="0.25" />
          <circle cx="500" cy="500" r="490" stroke="#1d4ed8" strokeWidth="1.2" strokeDasharray="2 48" opacity="0.15" />
          <circle cx="500" cy="500" r="560" stroke="#2563eb" strokeWidth="1" strokeDasharray="4 54" opacity="0.1" />

          {/* Individual starry coordinate dots scattered precisely on the galactic field */}
          <circle cx="450" cy="440" r="2.5" fill="#93c5fd" opacity="0.9" className="animate-pulse" />
          <circle cx="560" cy="530" r="3" fill="#ffffff" opacity="0.9" />
          <circle cx="520" cy="430" r="1.5" fill="#60a5fa" opacity="0.8" />
          <circle cx="430" cy="520" r="2" fill="#3b82f6" opacity="0.8" />
          
          <circle cx="360" cy="380" r="3.5" fill="#93c5fd" opacity="0.9" className="animate-pulse" />
          <circle cx="640" cy="620" r="2" fill="#ffffff" opacity="0.75" />
          <circle cx="380" cy="580" r="2.5" fill="#60a5fa" opacity="0.85" />
          <circle cx="620" cy="410" r="3" fill="#3b82f6" opacity="0.9" />
          <circle cx="480" cy="340" r="1.5" fill="#ffffff" opacity="0.6" />
          <circle cx="520" cy="660" r="2" fill="#93c5fd" opacity="0.75" />

          <circle cx="280" cy="320" r="2" fill="#60a5fa" opacity="0.8" />
          <circle cx="720" cy="680" r="3.5" fill="#93c5fd" opacity="0.95" className="animate-pulse" />
          <circle cx="290" cy="640" r="3" fill="#ffffff" opacity="0.9" />
          <circle cx="710" cy="340" r="1.5" fill="#3b82f6" opacity="0.7" />
          <circle cx="470" cy="220" r="2" fill="#93c5fd" opacity="0.8" />
          <circle cx="530" cy="780" r="4" fill="#ffffff" opacity="0.8" />
          <circle cx="820" cy="480" r="2" fill="#60a5fa" opacity="0.75" />
          <circle cx="180" cy="520" r="3" fill="#3b82f6" opacity="0.85" />
        </svg>
      </div>

      <div className="max-w-4xl mx-auto text-center relative z-10 flex flex-col items-center select-none">
        
        <h3 className="font-display text-2xl sm:text-3xl font-medium text-white mb-4 tracking-tight select-none">
          Experience liftoff.
        </h3>
        
        <p className="text-zinc-400 text-xs sm:text-sm font-light leading-relaxed max-w-md mx-auto mb-10 select-none">
          Ship code with parallel coding agents.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 w-full sm:w-auto">
          <Link 
            href="/agents" 
            className="w-full sm:w-auto flex items-center justify-center gap-2.5 border border-white/15 bg-white/5 hover:bg-white/10 text-white px-6 py-2.5 rounded-full text-xs font-medium tracking-tight transition-all duration-300 transform hover:-translate-y-0.5 cursor-pointer whitespace-nowrap"
          >
            <span>Open Cloud Agents</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-400 stroke-[2.2]" />
          </Link>
          
          <a 
            href="https://github.com/Puneet-Pal-Singh/LegionCode"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto flex items-center justify-center gap-2.5 text-zinc-300 border border-white/10 bg-white/[0.02] hover:bg-white/5 px-6 py-2.5 rounded-full text-xs font-medium tracking-tight transition-all duration-300 transform hover:-translate-y-0.5 cursor-pointer shadow-inner whitespace-nowrap"
          >
            <Github className="w-3.5 h-3.5 text-zinc-500" />
            <span>Star on GitHub</span>
          </a>
        </div>

      </div>
    </section>
  );
}
