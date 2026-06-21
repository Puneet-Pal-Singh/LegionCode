'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Github, Search, Book, Menu, X, Command, Activity, Sparkles, AlertCircle } from 'lucide-react';
import { docsPages } from '@/lib/docs-data';

interface NavbarProps {
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
}

export function Navbar({ onToggleSidebar, isSidebarOpen }: NavbarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Load recent searches from localStorage hydration-safely
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('legioncode_recent_searches');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const t = setTimeout(() => {
            setRecentSearches(parsed);
          }, 0);
          return () => clearTimeout(t);
        } catch (e) {
          // Ignore parse errors
        }
      } else {
        const t = setTimeout(() => {
          setRecentSearches(['setup', 'mcp', 'agents']);
        }, 0);
        return () => clearTimeout(t);
      }
    }
  }, []);

  // Close search on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut (Cmd+K or Ctrl+K) to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Simple reactive search using useMemo to avoid setState in useEffect
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) {
      return [];
    }

    const query = searchQuery.toLowerCase();
    const results: Array<{ slug: string; title: string; category: string; matchType: 'title' | 'description' | 'content' }> = [];

    Object.values(docsPages).forEach(page => {
      if (page.title.toLowerCase().includes(query)) {
        results.push({ slug: page.slug, title: page.title, category: page.category, matchType: 'title' });
      } else if (page.description.toLowerCase().includes(query)) {
        results.push({ slug: page.slug, title: page.title, category: page.category, matchType: 'description' });
      } else {
        // Search inside page body text/code
        const matchElement = page.elements.some(el => {
          if ('text' in el && el.text) {
            return el.text.toLowerCase().includes(query);
          }
          if ('code' in el && el.code) {
            return el.code.toLowerCase().includes(query);
          }
          return false;
        });

        if (matchElement) {
          results.push({ slug: page.slug, title: page.title, category: page.category, matchType: 'content' });
        }
      }
    });

    return results.slice(0, 7); // limit to 7 results
  }, [searchQuery]);

  // Dynamic suggestions based on first item of recent searches
  const dynamicSuggestions = useMemo(() => {
    if (recentSearches.length === 0) {
      return ['worktrees', 'mcp', 'setup', 'sandbox'];
    }

    const lastSearch = recentSearches[0].toLowerCase();
    const related: string[] = [];

    // Let's analyze if lastSearch corresponds to something, and suggest corresponding key terms.
    if (lastSearch.includes('mcp') || lastSearch.includes('model') || lastSearch.includes('provider')) {
      related.push('providers', 'gemini', 'keys', 'harness');
    } else if (lastSearch.includes('agent') || lastSearch.includes('run') || lastSearch.includes('task')) {
      related.push('worktrees', 'sandbox', 'debugging', 'variables');
    } else if (lastSearch.includes('intro') || lastSearch.includes('setup') || lastSearch.includes('quick') || lastSearch.includes('start')) {
      related.push('repositories', 'pre-requisites', 'structure', 'clone');
    } else {
      // Find pages in the same category as the page matching the user's lastSearch
      let matchedCategory = '';
      Object.keys(docsPages).forEach(slug => {
        const page = docsPages[slug];
        if (page.title.toLowerCase().includes(lastSearch) || page.category.toLowerCase().includes(lastSearch)) {
          matchedCategory = page.category;
        }
      });

      if (matchedCategory) {
        Object.keys(docsPages).forEach(slug => {
          const page = docsPages[slug];
          if (page.category === matchedCategory && !page.title.toLowerCase().includes(lastSearch)) {
            related.push(page.title.toLowerCase().split(' ')[0]);
          }
        });
      }
    }

    // fallback pool to make sure we always have 4 unique suggestion tiles
    const pool = ['mcp', 'sandbox', 'worktrees', 'debugging', 'variables', 'repositories', 'providers'];
    for (const term of pool) {
      if (related.length >= 4) break;
      if (term !== lastSearch && !related.includes(term)) {
        related.push(term);
      }
    }

    return Array.from(new Set(related)).slice(0, 4);
  }, [recentSearches]);

  const selectResult = (slug: string) => {
    // Save current query to recent searches
    if (searchQuery.trim()) {
      const trimmed = searchQuery.trim();
      setRecentSearches(prev => {
        const updated = [trimmed, ...prev.filter(q => q.toLowerCase() !== trimmed.toLowerCase())].slice(0, 5);
        if (typeof window !== 'undefined') {
          localStorage.setItem('legioncode_recent_searches', JSON.stringify(updated));
        }
        return updated;
      });
    }
    router.push(`/docs/${slug}`);
    setIsSearchOpen(false);
    setSearchQuery('');
  };

  // Prevent scroll when search modal is open
  useEffect(() => {
    if (isSearchOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isSearchOpen]);

  return (
    <nav className="fixed top-0 left-0 right-0 h-14 bg-black/90 backdrop-blur-md border-b border-white/5 z-50 px-4 sm:px-6 flex items-center justify-between">
      {/* Left side: Logo & Brand */}
      <div className="flex items-center gap-3">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="md:hidden flex items-center justify-center p-1.5 rounded-md hover:bg-zinc-900 border border-white/5 text-zinc-400 hover:text-white transition-colors"
            aria-label="Toggle sidebar panel"
          >
            {isSidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        )}

        <Link href="/" className="flex items-center gap-1.5 group">
          <svg
            className="w-5 h-5 text-white mr-0.5 opacity-90 group-hover:opacity-100 transition-opacity"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M 7,17 L 2,12 L 7,7" />
            <line x1="12" y1="3" x2="12" y2="21" />
            <path d="M 17,7 L 22,12 L 17,17" />
          </svg>
          <div className="flex flex-col">
            <span className="font-semibold text-white tracking-tight text-sm leading-none group-hover:text-zinc-350 transition-colors">
              LegionCode
            </span>
            <span className="text-[9px] font-mono font-bold tracking-widest text-[#e4e4e7]/40 mt-0.5">
              DOCS
            </span>
          </div>
        </Link>
      </div>

      {/* Right side: search, changes log, github, launch agents order */}
      <div className="flex items-center gap-4 text-xs font-sans font-medium text-zinc-400">
        
        {/* Search trigger component */}
        <div 
          onClick={() => setIsSearchOpen(true)}
          className="w-32 flex items-center justify-between gap-1 px-2.5 py-1.5 rounded-md bg-zinc-900 border border-white/5 text-zinc-400 hover:text-white hover:border-white/15 transition-all duration-150 cursor-pointer"
          id="navbar-search-trigger"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <Search className="w-3 h-3 text-zinc-500 shrink-0" />
            <span className="text-xs font-sans truncate">search docs</span>
          </div>
          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-zinc-950 border border-white/5 text-[8px] font-mono text-zinc-500 shrink-0">
            <span className="opacity-65">⌘</span>
            <span>K</span>
          </div>
        </div>

        {/* Changes Log Link */}
        <Link 
          href="/docs/changelog" 
          className="hover:text-white transition-colors"
          id="navbar-changelog-link"
        >
          Changelog
        </Link>

        {/* GitHub Link */}
        <a
          href="https://github.com/Puneet-Pal-Singh/LegionCode"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-white transition-colors p-1 hover:bg-white/5 rounded"
          id="navbar-github-link"
          aria-label="LegionCode Github Repository"
        >
          <Github className="w-3.5 h-3.5 text-zinc-400" />
          <span className="hidden sm:inline">GitHub</span>
        </a>

        {/* Launch Agents Call-To-Action */}
        <button 
          className="bg-white text-black px-3 py-1.5 rounded-md text-xs font-bold hover:bg-zinc-200 hover:text-black hover:scale-[1.01] transition-all shadow"
          id="navbar-launch-agents-button"
        >
          Launch Agents
        </button>
      </div>

      {/* Fullscreen Search Modal Overlay */}
      {isSearchOpen && (
        <div 
          className="fixed inset-0 bg-black/85 backdrop-blur-2xl z-[100] flex items-start justify-center pt-[10vh] px-4 animate-in fade-in duration-200"
          id="search-modal-backdrop"
          onClick={() => {
            setIsSearchOpen(false);
            setSearchQuery('');
          }}
        >
          <div 
            className="w-full max-w-2xl bg-[#09090b] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-4 duration-200 flex flex-col"
            id="search-modal-container"
            onClick={e => e.stopPropagation()}
          >
            {/* Input Header Section */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/5 relative">
              <div className="flex-1 flex items-center gap-3">
                <Search className="w-5 h-5 text-zinc-500 shrink-0" />
                <input
                  autoFocus
                  type="text"
                  placeholder="Start searching"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && searchResults.length > 0) {
                      selectResult(searchResults[0].slug);
                    }
                  }}
                  className="w-full bg-transparent border-0 ring-0 outline-none text-base text-white placeholder-zinc-650 font-sans"
                  id="main-search-input"
                />
              </div>
              <button 
                onClick={() => {
                  setIsSearchOpen(false);
                  setSearchQuery('');
                }}
                className="p-1.5 hover:bg-zinc-900 rounded-lg text-zinc-400 hover:text-white transition-colors"
                aria-label="Close search"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Scrollable Box */}
            <div className="p-6 max-h-[55vh] overflow-y-auto select-none scrollbar-hide">
              {!searchQuery.trim() ? (
                <div className="flex flex-col gap-6">
                  {/* Recent Queries */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold font-mono">Recent</h3>
                      {recentSearches.length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRecentSearches([]);
                            if (typeof window !== 'undefined') {
                              localStorage.removeItem('legioncode_recent_searches');
                            }
                          }}
                          className="text-[9px] font-mono text-zinc-550 hover:text-zinc-400 transition-colors uppercase cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {recentSearches.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {recentSearches.map(term => (
                          <button
                            key={term}
                            onClick={() => setSearchQuery(term)}
                            className="px-3 py-1 text-xs text-zinc-400 hover:text-white hover:border-white/15 bg-zinc-900 hover:bg-zinc-850 border border-white/5 rounded-full transition-all font-sans cursor-pointer"
                          >
                            {term}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-zinc-600 font-sans italic">
                        No recent search history.
                      </div>
                    )}
                  </div>

                  {/* Suggested Queries */}
                  <div>
                    <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-3 font-mono">Suggested</h3>
                    <div className="flex flex-wrap gap-2">
                      {dynamicSuggestions.map(term => (
                        <button
                          key={term}
                          onClick={() => setSearchQuery(term)}
                          className="px-3.5 py-1 text-xs text-zinc-400 hover:text-white hover:border-white/15 bg-zinc-900 hover:bg-zinc-850 border border-white/5 rounded-full transition-all font-sans cursor-pointer"
                        >
                          {term}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                /* Dynamic Matching Results List */
                <div className="flex flex-col gap-4">
                  {searchResults.length > 0 ? (
                    searchResults.map(result => (
                      <div
                        key={result.slug}
                        onClick={() => selectResult(result.slug)}
                        className="group p-2.5 rounded-lg cursor-pointer transition-colors duration-100 flex flex-col gap-0.5 hover:bg-zinc-900/60"
                      >
                        <div className="flex items-center gap-1 text-[10px] text-zinc-500 font-mono tracking-wider uppercase">
                          <span>LegionCode</span>
                          <span>&rsaquo;</span>
                          <span>{result.category}</span>
                        </div>
                        <div className="text-sm font-semibold text-zinc-100 group-hover:text-white transition-colors">
                          {result.title}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="py-8 text-center text-zinc-500 text-xs">
                      No matching documentation pages found for &ldquo;{searchQuery}&rdquo;.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer with ESC guidance */}
            <div className="px-6 py-3.5 bg-zinc-950/60 border-t border-white/5 flex items-center justify-between text-[10px] text-zinc-550 font-mono">
              <span className="flex items-center gap-1">
                Press <kbd className="px-1.5 py-0.5 bg-zinc-900 rounded border border-white/5 text-[9px] text-zinc-400">ESC</kbd> to exit
              </span>
              <span>LegionCode Search Engine</span>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
