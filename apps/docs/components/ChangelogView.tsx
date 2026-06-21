'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface UpdateSection {
  title: string;
  items: React.ReactNode[];
}

interface ChangelogEntry {
  id: string;
  version: string;
  date: string;
  category: 'general' | 'workspace-app' | 'execution-harness' | 'legion-cli' | 'model-providers';
  categoryLabel: string;
  monthId: string;
  monthLabel: string;
  sections: UpdateSection[];
}

const CATEGORIES = [
  { id: 'all', label: 'All updates' },
  { id: 'general', label: 'General' },
  { id: 'workspace-app', label: 'Workspace app' },
  { id: 'execution-harness', label: 'Execution harness' },
  { id: 'legion-cli', label: 'Legion CLI' },
  { id: 'model-providers', label: 'Model providers' }
];

const CHANGELOG_DATA: ChangelogEntry[] = [
  {
    id: 'update-2026-06-11',
    version: 'Workspace app 2.4.1',
    date: '2026-06-11',
    category: 'workspace-app',
    categoryLabel: 'Workspace app',
    monthId: 'june-2026',
    monthLabel: 'June 2026',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f1">Added <strong className="text-white font-medium">rate-limit reset banking</strong> for Plus and Pro workspaces, enabling parallel execution streams to bank and redeem query tokens.</span>,
          <span key="f2">Introduced a <span className="underline underline-offset-4 decoration-zinc-850 hover:decoration-white transition-colors cursor-pointer">Developer mode</span> proxy layer for sandbox container networking inside Chrome. This facilitates remote debugging of network traffic directly from host machines.</span>,
          <span key="f3">Added filesystem workspace sync utilities to instantly backup changes live into secure ephemeral volumes.</span>
        ]
      },
      {
        title: 'Improvements',
        items: [
          <span key="i1">Upgraded Monaco editor definitions to support real-time token tracking and estimated payload weights during active prompt authoring.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2026-05-28',
    version: 'Legion CLI v1.9.0',
    date: '2026-05-28',
    category: 'legion-cli',
    categoryLabel: 'Legion CLI',
    monthId: 'may-2026',
    monthLabel: 'May 2026',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f4">Added non-interactive validation gates via <code className="text-xs bg-zinc-900 border border-white/5 py-0.5 px-1.5 rounded text-zinc-300 font-mono">legion test --non-interactive</code> to run inside the execution harness without requiring terminal focus.</span>,
          <span key="f5">Option to push and update environment variable bindings concurrently using the secure profile API.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2026-04-15',
    version: 'Execution harness 1.25.0',
    date: '2026-04-15',
    category: 'execution-harness',
    categoryLabel: 'Execution harness',
    monthId: 'april-2026',
    monthLabel: 'April 2026',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f6">Added isolated <strong className="text-white font-medium">V8 execution boundaries</strong> for evaluating Untrusted Script expressions instantly without triggering slow sandbox cold starts.</span>
        ]
      },
      {
        title: 'Improvements',
        items: [
          <span key="i2">Drastically reduced memory usage of concurrent docker layer mounts under high queue pressures.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2026-03-03',
    version: 'Model providers 1.12.0',
    date: '2026-03-03',
    category: 'model-providers',
    categoryLabel: 'Model providers',
    monthId: 'march-2026',
    monthLabel: 'March 2026',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f7">Added native provider support for Gemini 3.5 API and OpenCode-Zen and OpenCode-Go fine-tuned coding models.</span>
        ]
      },
      {
        title: 'Fixes',
        items: [
          <span key="fx1">Resolved an issue of lingering TCP socket handles during high-parallel model toolcalls across Claude 3.5 Sonnet endpoints.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2026-02-14',
    version: 'Workspace app 2.3.0',
    date: '2026-02-14',
    category: 'workspace-app',
    categoryLabel: 'Workspace app',
    monthId: 'february-2026',
    monthLabel: 'February 2026',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f8">Integrated visual split-diff editors with syntax-aware line matching and chunk operations.</span>,
          <span key="f9">Added context custom rules parser matching workspace directories automatically for precise file generation instructions.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2026-01-10',
    version: 'General 1.1.0',
    date: '2026-01-10',
    category: 'general',
    categoryLabel: 'General',
    monthId: 'january-2026',
    monthLabel: 'January 2026',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f10">Added secure Team workspaces supporting shared OAuth connections and multi-user audit logging.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2025-12-18',
    version: 'Legion CLI v1.8.0',
    date: '2025-12-18',
    category: 'legion-cli',
    categoryLabel: 'Legion CLI',
    monthId: 'december-2025',
    monthLabel: 'December 2025',
    sections: [
      {
        title: 'Improvements',
        items: [
          <span key="i3">Sparse-git tree synchronization allows downloading only files accessed by the agent, reducing checkout latencies over large repos by 80%.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2025-11-05',
    version: 'Execution harness 1.10.4',
    date: '2025-11-05',
    category: 'execution-harness',
    categoryLabel: 'Execution harness',
    monthId: 'november-2025',
    monthLabel: 'November 2025',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f11">Integrated automated telemetry signals for local Docker daemon profiles under dev mode.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2025-10-22',
    version: 'Model providers 1.8.0',
    date: '2025-10-22',
    category: 'model-providers',
    categoryLabel: 'Model providers',
    monthId: 'october-2025',
    monthLabel: 'October 2025',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f12">Enabled stream caching for Claude 3 Opus models, saving average input token overheads during back-to-back chat refinement loops.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2025-09-14',
    version: 'General 1.0.0',
    date: '2025-09-14',
    category: 'general',
    categoryLabel: 'General',
    monthId: 'september-2025',
    monthLabel: 'September 2025',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f13">Official stable release of LegionCode 1.0. Built on serverless Cloudflare Workers, a fully local dev harness CLI, and modular UI views.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2025-08-30',
    version: 'Workspace app 2.0.0',
    date: '2025-08-30',
    category: 'workspace-app',
    categoryLabel: 'Workspace app',
    monthId: 'august-2025',
    monthLabel: 'August 2025',
    sections: [
      {
        title: 'Improvements',
        items: [
          <span key="i4">Redesigned the main dashboard view with rich custom-crafted slate dark elements, fluid visual hierarchies, and responsive panels.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2025-07-12',
    version: 'Execution harness 1.0.0-rc.2',
    date: '2025-07-12',
    category: 'execution-harness',
    categoryLabel: 'Execution harness',
    monthId: 'july-2025',
    monthLabel: 'July 2025',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f14">Added experimental isolation mode using micro-VM configurations for enterprise deployments.</span>
        ]
      }
    ]
  },
  {
    id: 'update-2025-06-10',
    version: 'General 0.1.0',
    date: '2025-06-10',
    category: 'general',
    categoryLabel: 'General',
    monthId: 'june-2025',
    monthLabel: 'June 2025',
    sections: [
      {
        title: 'New features',
        items: [
          <span key="f15">LegionCode Public Alpha launched! Complete with interactive React-driven layout, unified providers keys config, and integrated validation gates.</span>
        ]
      }
    ]
  }
];

export function ChangelogView() {
  const [activeCategory, setActiveCategory] = useState('all');
  const [activeMonth, setActiveMonth] = useState('');

  // Filter entries based on selected category
  const filteredEntries = useMemo(() => {
    if (activeCategory === 'all') {
      return CHANGELOG_DATA;
    }
    return CHANGELOG_DATA.filter(entry => entry.category === activeCategory);
  }, [activeCategory]);

  // Group filtered entries by Month
  const groupedEntries = useMemo(() => {
    const groups: { monthId: string; monthLabel: string; entries: ChangelogEntry[] }[] = [];
    
    filteredEntries.forEach(entry => {
      const existing = groups.find(g => g.monthId === entry.monthId);
      if (existing) {
        existing.entries.push(entry);
      } else {
        groups.push({
          monthId: entry.monthId,
          monthLabel: entry.monthLabel,
          entries: [entry]
        });
      }
    });

    return groups;
  }, [filteredEntries]);

  // Handle active month tracing on scroll
  useEffect(() => {
    if (groupedEntries.length === 0) return;
    
    // Set initial active month on timeout to prevent synchronous state cascading
    const t = setTimeout(() => {
      setActiveMonth(groupedEntries[0].monthId);
    }, 0);

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setActiveMonth(entry.target.id);
        }
      });
    }, {
      rootMargin: '-10% 0px -65% 0px' // triggers when the section is near the upper center of viewport
    });

    const sections = document.querySelectorAll('.changelog-month-section');
    sections.forEach((section) => observer.observe(section));

    return () => {
      clearTimeout(t);
      sections.forEach((section) => observer.unobserve(section));
    };
  }, [groupedEntries]);

  const scrollToMonth = (monthId: string) => {
    setActiveMonth(monthId);
    const element = document.getElementById(monthId);
    if (element) {
      const offset = 90; // offset for the sticky navbar and comfort
      const bodyRect = document.body.getBoundingClientRect().top;
      const elementRect = element.getBoundingClientRect().top;
      const elementPosition = elementRect - bodyRect;
      const offsetPosition = elementPosition - offset;

      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      });
    }
  };

  return (
    <div className="w-full flex gap-8 items-start lg:gap-12 relative" id="changelog-view-container">
      {/* Left side: Main Content list of updates */}
      <div className="flex-1 min-w-0" id="changelog-main-column">
        {/* Title & Subtitle */}
        <div className="mb-10 animate-in fade-in slide-in-from-top-3 duration-200" id="changelog-header-section">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white font-sans mb-3 font-semibold pb-1">
            LegionCode changelog
          </h1>
          <p className="text-sm sm:text-base text-zinc-400 font-sans leading-relaxed">
            Latest updates to LegionCode, the web-native coding agent workspace
          </p>
        </div>

        {/* Categories Pills container */}
        <div className="flex flex-wrap gap-2.5 mb-12 border-b border-white/5 pb-8 overflow-x-auto scrollbar-none" id="changelog-categories-bar">
          {CATEGORIES.map(cat => {
            const isSelected = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={cn(
                  "px-3.5 py-1.5 rounded-full text-xs font-sans font-semibold border transition-all duration-150 cursor-pointer text-center whitespace-nowrap shrink-0",
                  isSelected
                    ? "bg-blue-600/15 border-blue-500/20 text-blue-400 font-medium"
                    : "bg-zinc-900/60 hover:bg-zinc-850 border-white/5 text-zinc-400 hover:text-white"
                )}
                id={`filter-pill-${cat.id}`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* List of Updates by Month */}
        <div className="space-y-20" id="changelog-entries-list">
          {groupedEntries.length > 0 ? (
            groupedEntries.map(({ monthId, monthLabel, entries }) => (
              <section
                key={monthId}
                id={monthId}
                className="changelog-month-section scroll-mt-24"
              >
                {/* Month Large Header */}
                <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white mb-8 border-b border-white/5 pb-3">
                  {monthLabel}
                </h2>

                {/* Sub-list of entries in this month */}
                <div className="space-y-16">
                  {entries.map((entry) => (
                    <div key={entry.id} className="relative pl-0 sm:pl-1 transition-all duration-300" id={`entry-${entry.id}`}>
                      {/* Date Indicator of update */}
                      <div className="text-xs font-mono text-zinc-500 mb-2 tracking-wider">
                        {entry.date}
                      </div>

                      {/* Title of Update heading */}
                      <h3 className="text-xl sm:text-2.5xl font-bold tracking-tight text-white pb-1">
                        {entry.version}
                      </h3>

                      {/* Render Sections (New features, Improvements, Fixes) */}
                      <div className="mt-5 space-y-6">
                        {entry.sections.map((sec, sidx) => (
                          <div key={sidx} className="space-y-3.5">
                            <h4 className="text-[10px] font-bold tracking-widest uppercase text-zinc-500 font-mono">
                              {sec.title}
                            </h4>
                            <ul className="list-disc pl-5 space-y-3 text-zinc-300 font-sans leading-relaxed text-[15px]">
                              {sec.items.map((item, iidx) => (
                                <li key={iidx} className="pl-1">
                                  {item}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <div className="text-center py-20 text-zinc-500 text-sm italic border border-white/5 rounded-xl bg-zinc-950/20">
              No updates available for this category selection.
            </div>
          )}
        </div>
      </div>

      {/* Right side Sticky month timeline navigation */}
      {groupedEntries.length > 0 && (
        <aside className="sticky top-24 right-0 w-44 shrink-0 hidden lg:block select-none pointer-events-auto" id="changelog-rightbar-toc">
          <nav className="flex flex-col gap-3.5 border-l border-white/5 pl-4 py-1">
            {groupedEntries.map((group) => {
              const isActive = activeMonth === group.monthId;
              return (
                <button
                  key={group.monthId}
                  onClick={() => scrollToMonth(group.monthId)}
                  className={cn(
                    "text-xs transition-all duration-150 leading-relaxed block text-left truncate pl-3 relative group cursor-pointer focus:outline-none",
                    isActive
                      ? "text-white font-semibold border-l-2 border-white -ml-[18px]"
                      : "text-zinc-500 hover:text-zinc-300 font-semibold"
                  )}
                  id={`timeline-item-${group.monthId}`}
                >
                  {group.monthLabel}
                </button>
              );
            })}
          </nav>
        </aside>
      )}
    </div>
  );
}
