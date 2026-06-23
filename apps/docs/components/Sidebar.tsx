"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { sidebarStructure } from "@/lib/docs-navigation";

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

function SidebarCategory({
  category,
  pathname,
  onClose,
}: {
  category: (typeof sidebarStructure)[number];
  pathname: string;
  onClose?: () => void;
}) {
  return (
    <div className="flex flex-col" id={`category-${category.id}`}>
      <div className="mb-2 flex items-center gap-1.5 px-2 py-1 font-sans text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        <span>{category.title}</span>
      </div>
      <div className="flex flex-col gap-0.5 pl-1">
        {category.pages.map((page) => {
          const active =
            pathname === `/docs/${page.slug}` ||
            pathname === `/docs/${page.slug}/` ||
            (pathname === "/docs" && page.slug === "overview");
          return (
            <Link
              key={page.slug}
              href={`/${page.slug}/`}
              onClick={onClose}
              className={cn(
                "relative flex items-center justify-between rounded-md px-2 py-1.5 font-sans text-xs transition-all duration-150",
                active
                  ? "bg-white/5 font-medium text-white"
                  : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200",
              )}
              id={`link-${page.slug}`}
            >
              <span className="truncate">{page.title}</span>
              {page.status && (
                <span className="inline-flex scale-90 items-center gap-0.5 rounded border border-violet-850/50 bg-violet-950/40 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-violet-300">
                  {page.status}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "fixed top-14 bottom-0 left-0 w-64 bg-black border-r border-white/5 z-40 overflow-y-auto select-none transition-transform duration-200 md:translate-x-0 scrollbar-hide",
        isOpen ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="p-4 flex flex-col gap-6">
        {sidebarStructure.map((category) => (
          <SidebarCategory
            key={category.id}
            category={category}
            pathname={pathname}
            onClose={onClose}
          />
        ))}
      </div>
      {/* Footer Branding */}
      <div className="p-5 border-t border-white/5 mt-6 text-[10px] font-mono text-zinc-500 flex flex-col gap-1">
        <div>LegionCode Docs Portal</div>
        <div>Private Alpha v0.1.0</div>
      </div>
    </aside>
  );
}
