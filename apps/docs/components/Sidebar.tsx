'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { sidebarStructure } from '@/lib/docs-data';
import { Sparkles } from 'lucide-react';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();

  // Helper to check if a page is currently active
  const isActive = (slug: string) => {
    return pathname === `/docs/${slug}` || (pathname === '/docs' && slug === 'introduction');
  };

  return (
    <aside
      className={cn(
        "fixed top-14 bottom-0 left-0 w-64 bg-black border-r border-white/5 z-40 overflow-y-auto select-none transition-transform duration-200 md:translate-x-0 scrollbar-hide",
        isOpen ? "translate-x-0" : "-translate-x-full"
      )}
    >
      <div className="p-4 flex flex-col gap-6">
        {sidebarStructure.map(category => (
          <div key={category.id} className="flex flex-col" id={`category-${category.id}`}>
            {/* Category Header */}
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500 font-sans mb-2">
              <span>{category.title}</span>
            </div>

            {/* Pages list */}
            <div className="flex flex-col gap-0.5 pl-1">
              {category.pages.map(page => {
                const active = isActive(page.slug);
                return (
                  <Link
                    key={page.slug}
                    href={`/docs/${page.slug}`}
                    onClick={() => {
                      if (onClose) onClose();
                    }}
                    className={cn(
                      "flex items-center justify-between px-2 py-1.5 text-xs rounded-md transition-all duration-150 relative font-sans",
                      active
                        ? "bg-white/5 text-white font-medium"
                        : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                    )}
                    id={`link-${page.slug}`}
                  >
                    <span className="truncate">{page.title}</span>
                    {page.status && (
                      <span className="inline-flex items-center gap-0.5 text-[8px] font-bold px-1.5 py-0.5 rounded bg-violet-950/40 text-violet-300 border border-violet-850/50 uppercase tracking-wider scale-90">
                        {page.status}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {/* Footer Branding */}
      <div className="p-5 border-t border-white/5 mt-6 text-[10px] font-mono text-zinc-500 flex flex-col gap-1">
        <div>LegionCode Docs Portal</div>
        <div>Public Alpha v0.0.1</div>
      </div>
    </aside>
  );
}
