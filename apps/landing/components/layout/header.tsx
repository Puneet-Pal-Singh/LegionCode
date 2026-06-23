"use client";

import React, { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { Github, Menu, X, ArrowUpRight } from "lucide-react";

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 bg-black/30 backdrop-blur-xl border-b border-white/10 px-6 py-4 transition-all duration-300">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 select-none group">
          <svg
            aria-hidden="true"
            className="w-8 h-5 text-white group-hover:text-zinc-300 transition-colors"
            viewBox="0 0 72 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M18 6L4 16L18 26"
              stroke="currentColor"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line
              x1="36"
              y1="4"
              x2="36"
              y2="28"
              stroke="currentColor"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
            <path
              d="M54 6L68 16L54 26"
              stroke="currentColor"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-sans font-semibold text-xl tracking-tight text-white ml-0.5">
            LegionCode
          </span>
        </Link>

        {/* Header Actions & Navigation (Right-aligned) */}
        <div className="flex items-center gap-8">
          {/* Desktop Navigation Links */}
          <nav
            aria-label="Primary"
            className="hidden md:flex items-center gap-8 text-zinc-400 text-xs font-mono"
          >
            <Link
              href="/cloud"
              className="text-zinc-400 hover:text-white transition-colors"
            >
              Cloud
            </Link>
            <Link
              href="/docs"
              prefetch={false}
              className="text-zinc-400 hover:text-white transition-colors"
            >
              Docs
            </Link>
            <a
              href="https://github.com/Puneet-Pal-Singh/LegionCode"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-white transition-colors flex items-center gap-1.5"
            >
              <Github className="w-3.5 h-3.5" />
              <span>GitHub</span>
            </a>
          </nav>

          <div className="flex items-center gap-3">
            <Link
              href="/cloud"
              className="hidden sm:flex items-center gap-1.5 bg-white hover:bg-neutral-100 text-black px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200"
            >
              <span>Request Access</span>
              <ArrowUpRight className="w-3.5 h-3.5 text-black stroke-[2.5]" />
            </Link>

            {/* Mobile Menu Button */}
            <button
              type="button"
              aria-label={
                mobileMenuOpen ? "Close navigation" : "Open navigation"
              }
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden flex items-center justify-center p-2 rounded-lg border border-white/10 hover:bg-white/5 text-zinc-400 hover:text-white transition-all cursor-pointer"
            >
              {mobileMenuOpen ? (
                <X className="w-4 h-4" />
              ) : (
                <Menu className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Dropdown Navigation */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            role="navigation"
            aria-label="Mobile"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="md:hidden absolute top-full left-0 w-full bg-[#0a0a0a]/95 backdrop-blur-2xl border-b border-white/10 px-6 py-5 flex flex-col gap-4 font-mono text-xs text-zinc-300 animate-in fade-in slide-in-from-top-2"
          >
            <Link
              href="/cloud"
              onClick={() => setMobileMenuOpen(false)}
              className="hover:text-white py-1 block border-b border-white/5 font-mono"
            >
              Cloud
            </Link>
            <Link
              href="/docs"
              prefetch={false}
              onClick={() => setMobileMenuOpen(false)}
              className="hover:text-white py-1 block border-b border-white/5 font-mono"
            >
              Docs
            </Link>
            <a
              href="https://github.com/Puneet-Pal-Singh/LegionCode"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileMenuOpen(false)}
              className="hover:text-white py-1 flex items-center gap-2 border-b border-white/5 font-mono"
            >
              <Github className="w-4 h-4" />
              <span>GitHub</span>
            </a>
            <Link
              href="/cloud"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center justify-center gap-1.5 bg-white text-black py-2.5 rounded-lg text-xs font-semibold hover:bg-neutral-100 transition-colors font-mono"
            >
              <span>Request Access</span>
              <ArrowUpRight className="w-3.5 h-3.5 text-black stroke-[2.5]" />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
