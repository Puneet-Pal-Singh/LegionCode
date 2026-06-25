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
            className="w-7 h-7 text-white group-hover:text-zinc-300 transition-colors"
            viewBox="2800 2850 6900 6900"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <g transform="translate(0 12540) scale(1 -1)" fill="currentColor">
              <path d="M7662 8873 c-121 -362 -293 -872 -382 -1133 -89 -261 -181 -533 -205 -605 -24 -71 -96 -283 -160 -470 -64 -187 -231 -677 -370 -1090 -139 -412 -293 -869 -342 -1015 l-90 -264 -244 -170 c-255 -176 -676 -466 -864 -594 -60 -42 -143 -98 -182 -125 -40 -28 -75 -48 -78 -45 -3 2 38 133 91 289 53 156 147 435 209 619 62 184 173 508 245 720 73 212 223 655 335 985 112 330 310 913 440 1295 130 382 294 864 364 1070 l128 374 429 273 c236 151 492 314 569 362 77 49 180 114 230 145 49 31 91 53 93 47 2 -5 -96 -306 -216 -668z M5450 8125 c0 -2 -50 -161 -111 -352 -61 -192 -119 -375 -130 -408 -14 -44 -26 -64 -46 -76 -16 -9 -170 -109 -343 -222 -173 -113 -435 -283 -582 -377 -148 -95 -268 -175 -268 -180 0 -5 26 -44 58 -87 149 -200 615 -859 619 -873 4 -15 -236 -765 -242 -758 -9 11 -693 972 -848 1193 -105 149 -248 353 -320 454 -106 150 -127 185 -115 195 7 7 114 77 238 156 124 79 405 261 625 403 220 143 594 384 830 536 237 152 473 304 525 338 91 59 110 69 110 58z M8330 7905 c51 -71 109 -152 130 -180 236 -318 910 -1260 1072 -1496 41 -60 41 -63 22 -77 -10 -8 -264 -174 -564 -369 -300 -195 -725 -473 -945 -618 -675 -443 -867 -567 -870 -563 -2 3 54 184 189 613 37 116 73 216 80 223 7 8 125 87 262 177 827 543 1003 661 1000 671 -4 11 -95 136 -566 782 -93 129 -170 239 -170 245 0 11 217 683 236 730 9 24 10 23 124 -138z" />
            </g>
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
