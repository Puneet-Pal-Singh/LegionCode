"use client";

import React, { useState } from "react";
import { Navbar } from "./Navbar";
import { Sidebar } from "./Sidebar";
import { cn } from "@/lib/utils";
import type { DocsSearchPage } from "@/lib/docs-content";

interface DocsLayoutProps {
  children: React.ReactNode;
  toc?: { id: string; text: string }[];
  searchPages: DocsSearchPage[];
}

function TableOfContents({ toc }: { toc: { id: string; text: string }[] }) {
  if (toc.length === 0) return null;
  return (
    <aside
      className="sticky right-0 top-20 hidden w-60 shrink-0 select-none xl:block"
      id="table-of-contents"
    >
      <div className="border-l border-white/5 py-1 pl-4">
        <span className="mb-4 block font-sans text-[10px] font-bold uppercase tracking-widest text-zinc-500">
          On this page
        </span>
        <nav className="flex flex-col gap-3">
          {toc.map((item, index) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={cn(
                "relative block truncate pl-3 text-xs leading-relaxed transition-colors duration-150",
                index === 0
                  ? "-ml-[17px] border-l border-white font-medium text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
              id={`toc-item-${item.id}`}
            >
              {item.text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

function DocsFooter() {
  return (
    <footer
      className="border-t border-white/5 bg-transparent px-4 py-6 md:px-8"
      id="docs-global-footer"
    >
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 font-mono text-xs text-zinc-550 sm:flex-row">
        <div>
          &copy; {new Date().getFullYear()} LegionCode. Released under the MIT
          License.
        </div>
        <div className="flex gap-4">
          <a href="https://github.com/Puneet-Pal-Singh/LegionCode/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-zinc-300">
            MIT License
          </a>
          <span>&bull;</span>
          <a href="https://github.com/Puneet-Pal-Singh/LegionCode" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-zinc-300">
            GitHub Repository
          </a>
        </div>
      </div>
    </footer>
  );
}

export function DocsLayout({
  children,
  toc = [],
  searchPages,
}: DocsLayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => !prev);
  };

  const closeSidebar = () => {
    setIsSidebarOpen(false);
  };

  return (
    <div
      className="min-h-screen bg-black text-[#e4e4e7] font-sans selection:bg-zinc-800 selection:text-white"
      id="docs-layout-root"
    >
      {/* Top Navbar */}
      <Navbar
        onToggleSidebar={toggleSidebar}
        isSidebarOpen={isSidebarOpen}
        searchPages={searchPages}
      />

      {/* Mobile Drawer Overlay Backdrop */}
      {isSidebarOpen && (
        <button
          type="button"
          aria-label="Close documentation navigation"
          onClick={closeSidebar}
          className="fixed inset-0 bg-black/80 z-30 md:hidden backdrop-blur-xs animate-in fade-in cursor-pointer"
          id="mobile-drawer-backdrop"
        />
      )}

      {/* Main Drawer/Sidebar Panel */}
      <Sidebar isOpen={isSidebarOpen} onClose={closeSidebar} />

      {/* Master Container Area wrapper */}
      <div
        className="md:pl-64 pt-14 min-h-screen flex flex-col justify-between"
        id="docs-viewport"
      >
        <main className="grow flex justify-center py-8 px-4 sm:px-6 lg:px-8">
          <div className="w-full max-w-7xl flex gap-8 items-start lg:gap-12 relative">
            {/* Center: Main Content Reading Container */}
            <article
              className="grow max-w-4xl min-w-0"
              id="docs-content-wrapper"
            >
              <div className="text-zinc-300">{children}</div>
            </article>

            <TableOfContents toc={toc} />
          </div>
        </main>

        <DocsFooter />
      </div>
    </div>
  );
}
