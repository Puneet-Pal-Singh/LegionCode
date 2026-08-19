'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import LegionCodeMark from '@/components/logo/legioncode-mark';

const SUBTITLES = [
  'The open-source AI coding agent.',
  'Run a team of coding agents in the cloud.',
];

export default function LandingHero() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % SUBTITLES.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="relative px-6 pt-12 md:pt-20 pb-4 md:pb-8 overflow-hidden flex flex-col items-center text-center">
      {/* Subtle Background Atmospheric Sky Glow (Matches mobile screenshot) */}
      <div className="absolute inset-x-0 top-0 h-[480px] bg-gradient-to-b from-[#2a3b68]/40 via-[#161a2e]/20 to-transparent -z-10 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[350px] bg-blue-500/10 rounded-full blur-[120px] -z-10 pointer-events-none" />

      {/* Centered LegionCode brand mark */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-white/[0.07] text-white shadow-2xl backdrop-blur-xl"
      >
        <LegionCodeMark className="h-8 w-8" />
      </motion.div>

      {/* Hero Title */}
      <motion.h1
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="font-display text-4xl sm:text-5xl md:text-6xl font-semibold tracking-tight text-white mb-3"
      >
        LegionCode
      </motion.h1>

      {/* Subtitle with subtle animated transitions */}
      <div className="h-8 sm:h-9 flex items-center justify-center my-1 max-w-xl overflow-hidden px-2">
        <AnimatePresence mode="wait">
          <motion.p
            key={index}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="text-zinc-400 text-base sm:text-lg font-light tracking-tight text-center"
          >
            {SUBTITLES[index]}
          </motion.p>
        </AnimatePresence>
      </div>

      {/* Primary Pill Button CTA */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="mt-6 mb-4"
      >
        <Link
          href="/agents"
          className="inline-flex items-center justify-center gap-2 bg-white text-black hover:bg-neutral-200 px-6 py-2.5 rounded-full text-sm font-medium tracking-tight shadow-[0_0_25px_rgba(255,255,255,0.18)] hover:shadow-[0_0_35px_rgba(255,255,255,0.3)] transition-all duration-200 transform hover:-translate-y-0.5 whitespace-nowrap"
        >
          <span>Explore Cloud Agents</span>
          <ArrowRight className="w-4 h-4 text-black stroke-[2.2]" />
        </Link>
      </motion.div>

    </section>
  );
}
