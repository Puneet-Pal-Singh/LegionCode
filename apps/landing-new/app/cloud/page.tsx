'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import AnnouncementBanner from '@/components/layout/announcement-banner';
import Header from '@/components/layout/header';
import Footer from '@/components/layout/footer';
import CloudBackground from '@/components/cloud/cloud-background';
import LogoAscii from '@/components/logo/logo-ascii';

export default function CloudPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleWaitlistSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes('@')) return;
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      setSubmitted(true);
      setEmail('');
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-black font-sans text-zinc-100 flex flex-col selection:bg-white selection:text-black antialiased overflow-hidden relative">
      
      {/* BACKGROUND ASCII DEBRIS & TEXTURE WALL */}
      <CloudBackground />

      {/* Top Announcement Banner */}
      <AnnouncementBanner />

      {/* HEADER SECTION - Minimal monochrome layout */}
      <Header />

      {/* CLOUD CENTRAL HERO (Perfect visual reproduction of the screenshot) */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 sm:px-6 sm:py-20 relative z-10">
        
        <div className="max-w-4xl w-full mx-auto flex flex-col items-center text-center">
          
          {/* EARLY ACCESS badge (in a subtle grey box) */}
          <div className="px-3 py-1 rounded border border-white/15 bg-zinc-900/60 text-zinc-400 font-mono text-[10px] tracking-[0.2em] uppercase mb-8 select-none">
            Early Access
          </div>

          {/* Large Brand Lockup using custom high-fidelity responsive layout */}
          <LogoAscii badge="Cloud" />

          {/* Hero Headline */}
          <h1 className="font-sans text-[13px] min-[360px]:text-[14px] min-[400px]:text-base sm:text-lg md:text-xl lg:text-[22px] text-zinc-100 tracking-tight font-medium mb-10 px-2 sm:px-0 whitespace-nowrap">
            Run a team of coding agents in the <span className="underline underline-offset-4 decoration-zinc-650 cursor-pointer hover:decoration-white transition-colors">cloud</span> ☁️
          </h1>

          {/* Unified Early Access Email Capture (Direct screenshot layout) */}
          <div className="w-full max-w-md px-2 sm:px-0">
            {!submitted ? (
              <form onSubmit={handleWaitlistSubmit} className="flex flex-col sm:flex-row items-center gap-2.5 sm:gap-2 sm:bg-zinc-950/40 sm:border sm:border-white/10 sm:rounded-xl sm:p-1.5 sm:focus-within:border-white/20 transition-all">
                <input 
                  type="email" 
                  required
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full sm:flex-1 bg-zinc-950/40 sm:bg-transparent border border-white/10 sm:border-none rounded-xl sm:rounded-none px-4 py-3 sm:py-2.5 text-zinc-100 placeholder-zinc-700 focus:outline-none text-xs font-mono text-center sm:text-left focus:border-white/20" 
                />
                <button 
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full sm:w-auto bg-zinc-900 border border-white/10 text-white hover:bg-zinc-850 px-5 py-3 sm:py-2.5 rounded-xl sm:rounded-lg text-xs font-mono transition-all cursor-pointer inline-flex items-center justify-center gap-1.5 disabled:opacity-50 font-medium sm:font-normal"
                >
                  {isSubmitting ? (
                    <span>Enrolls...</span>
                  ) : (
                    <>
                      <span>Get early access</span>
                      <span>→</span>
                    </>
                  )}
                </button>
              </form>
            ) : (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-zinc-950/40 p-4 rounded-xl border border-emerald-500/10 text-emerald-400 font-mono text-xs flex items-center justify-center gap-3"
              >
                <Check className="w-4 h-4 text-emerald-400 stroke-[2.5]" />
                <span>Reserved successfully. We will contact you soon.</span>
              </motion.div>
            )}

            {/* Recommendation notice */}
            <p className="text-[11px] font-mono text-zinc-500 mt-4 select-none px-4 sm:px-0">
              Use the email connected to your GitHub account.
            </p>

            {/* Microcopy notice */}
            <p className="text-[11px] font-mono text-zinc-500 mt-1.5 select-none px-4 sm:px-0">
              Private alpha. Access may be limited while cloud execution scales.
            </p>

            {/* Already have access link */}
            <div className="mt-6 pt-4 border-t border-white/[0.05]">
              <Link 
                href="/agents" 
                className="inline-flex items-center gap-1.5 text-xs font-mono text-zinc-400 hover:text-white transition-all group"
              >
                <span>Already have access? Open Cloud Agents</span>
                <span className="transform group-hover:translate-x-0.5 transition-transform">→</span>
              </Link>
            </div>
          </div>

        </div>
      </main>

      {/* MIT LOWER BAR FOOTER */}
      <Footer />

    </div>
  );
}
