'use client';

import React, { useState } from 'react';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';

interface DocsLayoutProps {
  children: React.ReactNode;
  toc?: { id: string; text: string }[];
  activeSlug: string;
}

export function DocsLayout({ children, toc = [], activeSlug }: DocsLayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const toggleSidebar = () => {
    setIsSidebarOpen(prev => !prev);
  };

  const closeSidebar = () => {
    setIsSidebarOpen(false);
  };

  return (
    <div className="min-h-screen bg-black text-[#e4e4e7] font-sans selection:bg-zinc-800 selection:text-white" id="docs-layout-root">
      {/* Top Navbar */}
      <Navbar onToggleSidebar={toggleSidebar} isSidebarOpen={isSidebarOpen} />

      {/* Mobile Drawer Overlay Backdrop */}
      {isSidebarOpen && (
        <div
          onClick={closeSidebar}
          className="fixed inset-0 bg-black/80 z-30 md:hidden backdrop-blur-xs animate-in fade-in cursor-pointer"
          id="mobile-drawer-backdrop"
        />
      )}

      {/* Main Drawer/Sidebar Panel */}
      <Sidebar isOpen={isSidebarOpen} onClose={closeSidebar} />

      {/* Master Container Area wrapper */}
      <div className="md:pl-64 pt-14 min-h-screen flex flex-col justify-between" id="docs-viewport">
        <main className="grow flex justify-center py-8 px-4 sm:px-6 lg:px-8">
          <div className="w-full max-w-7xl flex gap-8 items-start lg:gap-12 relative">
            
            {/* Center: Main Content Reading Container */}
            <article className="grow max-w-4xl min-w-0" id="docs-content-wrapper">
              <div className="text-zinc-300">
                {children}
              </div>
            </article>

            {/* Right Side: Sticky Table of Contents (Hidden on Smaller screens) */}
            {toc && toc.length > 0 && (
              <aside className="sticky top-20 right-0 w-60 shrink-0 hidden xl:block select-none" id="table-of-contents">
                <div className="border-l border-white/5 pl-4 py-1">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-sans block mb-4">On this page</span>
                  <nav className="flex flex-col gap-3">
                    {toc.map((item, index) => {
                      const isActive = index === 0;
                      return (
                        <a
                          key={item.id}
                          href={`#${item.id}`}
                          className={cn(
                            "text-xs transition-colors duration-150 leading-relaxed block truncate pl-3 relative",
                            isActive 
                              ? "text-white font-medium border-l border-white -ml-[17px]" 
                              : "text-zinc-500 hover:text-zinc-300"
                          )}
                          id={`toc-item-${item.id}`}
                        >
                          {item.text}
                        </a>
                      );
                    })}
                  </nav>
                </div>
              </aside>
            )}
            
          </div>
        </main>

        {/* Global Footer */}
        <footer className="border-t border-white/5 bg-transparent py-6 px-4 md:px-8" id="docs-global-footer">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-550 font-mono">
            <div>
              &copy; {new Date().getFullYear()} LegionCode. All rights reserved.
            </div>
            <div className="flex gap-4">
              <a href="https://github.com/Puneet-Pal-Singh/LegionCode/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-300 transition-colors">MIT License</a>
              <span>&bull;</span>
              <a href="https://github.com/Puneet-Pal-Singh/LegionCode" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-300 transition-colors">GitHub Repository</a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
