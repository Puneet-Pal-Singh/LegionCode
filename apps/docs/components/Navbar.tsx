"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Github, Menu, Search, X } from "lucide-react";
import type { DocsSearchPage } from "@/lib/docs-content";

interface NavbarProps {
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
  searchPages: DocsSearchPage[];
}

function useSearchDialog() {
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setIsOpen((current) => !current);
      }
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
  return { isOpen, setIsOpen };
}

function SearchTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-32 items-center justify-between gap-1 rounded-md border border-white/5 bg-zinc-900 px-2.5 py-1.5 text-zinc-400 transition-all hover:border-white/15 hover:text-white"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Search className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden="true" />
        <span className="truncate text-xs">search docs</span>
      </span>
      <kbd className="rounded border border-white/5 bg-zinc-950 px-1 py-0.5 text-[8px] text-zinc-500">
        ⌘K
      </kbd>
    </button>
  );
}

function SearchResults({
  pages,
  query,
  onSelect,
}: {
  pages: DocsSearchPage[];
  query: string;
  onSelect: () => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!normalizedQuery) return [];
    return pages
      .filter((page) =>
        [page.title, page.description, page.category, page.content]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
      .slice(0, 7);
  }, [normalizedQuery, pages]);

  if (!normalizedQuery) {
    return (
      <p className="py-8 text-center text-xs text-zinc-500">
        Search guides, workflows, configuration, and operations.
      </p>
    );
  }
  if (results.length === 0) {
    return (
      <p className="py-8 text-center text-xs text-zinc-500">
        No documentation matched “{query}”.
      </p>
    );
  }
  return results.map((result) => (
    <Link
      key={result.slug}
      href={`/${result.slug}/`}
      onClick={onSelect}
      className="group flex flex-col gap-0.5 rounded-lg p-2.5 transition-colors hover:bg-zinc-900/60"
    >
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        {result.category}
      </span>
      <span className="text-sm font-semibold text-zinc-100 group-hover:text-white">
        {result.title}
      </span>
      <span className="line-clamp-1 text-xs text-zinc-500">
        {result.description}
      </span>
    </Link>
  ));
}

function SearchDialog({
  pages,
  onClose,
}: {
  pages: DocsSearchPage[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/85 px-4 pt-[10vh] backdrop-blur-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Search documentation"
    >
      <div className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#09090b] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-white/5 px-6 py-5">
          <Search
            className="h-5 w-5 shrink-0 text-zinc-500"
            aria-hidden="true"
          />
          <input
            autoFocus
            type="search"
            aria-label="Search documentation"
            placeholder="Search documentation"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full bg-transparent text-base text-white outline-none placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-y-auto p-6">
          <SearchResults pages={pages} query={query} onSelect={onClose} />
        </div>
      </div>
    </div>
  );
}

function DocsBrand() {
  return (
    <Link href="/overview/" className="flex items-center gap-1.5">
      <span aria-hidden="true" className="text-white">
        &lt;|&gt;
      </span>
      <span className="text-sm font-semibold text-white">
        LegionCode{" "}
        <span className="ml-1 text-[9px] tracking-widest text-zinc-500">
          DOCS
        </span>
      </span>
    </Link>
  );
}

function DocsActions({ onSearch }: { onSearch: () => void }) {
  return (
    <div className="flex items-center gap-4 text-xs font-medium text-zinc-400">
      <SearchTrigger onClick={onSearch} />
      <Link href="/changelog/" className="hidden hover:text-white sm:inline">
        Changelog
      </Link>
      <a
        href="https://github.com/Puneet-Pal-Singh/LegionCode"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="LegionCode GitHub repository"
        className="rounded p-1 hover:bg-white/5 hover:text-white"
      >
        <Github className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
      {/* This exits the docs base path and returns to the product app. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/agents/"
        className="rounded-md bg-white px-3 py-1.5 font-bold text-black hover:bg-zinc-200"
      >
        Open Agents
      </a>
    </div>
  );
}

export function Navbar({
  onToggleSidebar,
  isSidebarOpen,
  searchPages,
}: NavbarProps) {
  const search = useSearchDialog();
  return (
    <nav
      className="fixed left-0 right-0 top-0 z-50 flex h-14 items-center justify-between border-b border-white/5 bg-black/90 px-4 backdrop-blur-md sm:px-6"
      aria-label="Documentation"
    >
      <div className="flex items-center gap-3">
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label={
              isSidebarOpen
                ? "Close documentation navigation"
                : "Open documentation navigation"
            }
            aria-expanded={isSidebarOpen}
            className="flex items-center justify-center rounded-md border border-white/5 p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white md:hidden"
          >
            {isSidebarOpen ? (
              <X className="h-4 w-4" />
            ) : (
              <Menu className="h-4 w-4" />
            )}
          </button>
        )}
        <DocsBrand />
      </div>
      <DocsActions onSearch={() => search.setIsOpen(true)} />
      {search.isOpen && (
        <SearchDialog
          pages={searchPages}
          onClose={() => search.setIsOpen(false)}
        />
      )}
    </nav>
  );
}
