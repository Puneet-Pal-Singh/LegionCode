"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type ChangelogCategory = "product" | "providers" | "platform";

interface ChangelogSection {
  category: ChangelogCategory;
  title: string;
  items: string[];
}

interface ChangelogRelease {
  version: string;
  date: string;
  monthId: string;
  monthLabel: string;
  sections: ChangelogSection[];
}

const categories: Array<{ id: "all" | ChangelogCategory; label: string }> = [
  { id: "all", label: "All updates" },
  { id: "product", label: "Product" },
  { id: "providers", label: "Providers" },
  { id: "platform", label: "Platform" },
];

const release: ChangelogRelease = {
  version: "v0.1.0 Private Alpha",
  date: "2026-06-22",
  monthId: "june-2026",
  monthLabel: "June 2026",
  sections: [
    {
      category: "product",
      title: "Product",
      items: [
        "Opened the hosted web workspace for private-alpha GitHub accounts.",
        "Added repository and branch selection, independent task conversations, and run-scoped cloud workspaces.",
        "Added changed-file summaries and unified or split diff review before explicit Git actions.",
        "Added supervised, auto-edit, same-repository, and full-access permission modes.",
      ],
    },
    {
      category: "providers",
      title: "Providers",
      items: [
        "Added BYOK connections and model catalogs for OpenRouter, OpenAI, Groq, Anthropic, Google Gemini, Together AI, Cerebras, OpenCode Go, and OpenCode Zen.",
        "Added encrypted cloud credential persistence, validation status, provider preferences, and per-run model selection.",
        "Marked Cloudflare AI as coming soon until its account metadata, catalog, validation, and execution route are complete.",
      ],
    },
    {
      category: "platform",
      title: "Platform",
      items: [
        "Separated orchestration in Brain from filesystem and command execution in Secure API.",
        "Scoped execution, worktrees, streaming events, transcripts, permissions, and artifact review metadata by runId.",
        "Made Postgres through Hyperdrive the canonical store for authenticated product state and added ordered migration handling.",
        "Published static landing and documentation applications with Cloudflare Pages routing for /agents and /docs, including the changelog.",
      ],
    },
  ],
};

function CategoryFilters({
  active,
  onChange,
}: {
  active: "all" | ChangelogCategory;
  onChange: (category: "all" | ChangelogCategory) => void;
}) {
  return (
    <div className="mb-12 flex flex-wrap gap-2.5 overflow-x-auto border-b border-white/5 pb-8">
      {categories.map((category) => (
        <button
          key={category.id}
          type="button"
          onClick={() => onChange(category.id)}
          aria-pressed={active === category.id}
          className={cn(
            "shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-center text-xs font-semibold transition-all",
            active === category.id
              ? "border-blue-500/20 bg-blue-600/15 text-blue-400"
              : "border-white/5 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800 hover:text-white",
          )}
        >
          {category.label}
        </button>
      ))}
    </div>
  );
}

function ReleaseSection({ section }: { section: ChangelogSection }) {
  return (
    <div className="space-y-3.5">
      <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        {section.title}
      </h4>
      <ul className="list-disc space-y-3 pl-5 text-[15px] leading-relaxed text-zinc-300">
        {section.items.map((item) => (
          <li key={item} className="pl-1">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReleaseArticle({ sections }: { sections: ChangelogSection[] }) {
  return (
    <section id={release.monthId} className="scroll-mt-24">
      <h2 className="mb-8 border-b border-white/5 pb-3 text-xl font-bold tracking-tight text-white sm:text-2xl">
        {release.monthLabel}
      </h2>
      <article>
        <div className="mb-2 font-mono text-xs tracking-wider text-zinc-500">
          {release.date}
        </div>
        <h3 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
          {release.version}
        </h3>
        <div className="mt-6 space-y-8">
          {sections.map((section) => (
            <ReleaseSection key={section.category} section={section} />
          ))}
        </div>
      </article>
    </section>
  );
}

function ChangelogMonths() {
  return (
    <aside className="sticky top-24 hidden w-44 shrink-0 select-none lg:block">
      <nav aria-label="Changelog months" className="border-l border-white/5 py-1 pl-4">
        <a href={`#${release.monthId}`} className="-ml-[17px] block border-l border-white pl-3 text-xs font-semibold text-white">
          {release.monthLabel}
        </a>
      </nav>
    </aside>
  );
}

export function ChangelogView() {
  const [activeCategory, setActiveCategory] = useState<
    "all" | ChangelogCategory
  >("all");
  const sections = useMemo(
    () =>
      activeCategory === "all"
        ? release.sections
        : release.sections.filter(
            (section) => section.category === activeCategory,
          ),
    [activeCategory],
  );

  return (
    <div className="relative flex w-full items-start gap-8 lg:gap-12">
      <div className="min-w-0 flex-1">
        <header className="mb-10">
          <h1 className="mb-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            LegionCode changelog
          </h1>
          <p className="text-sm leading-relaxed text-zinc-400 sm:text-base">
            User-facing releases from the first private-alpha launch onward.
          </p>
        </header>
        <CategoryFilters active={activeCategory} onChange={setActiveCategory} />
        <ReleaseArticle sections={sections} />
      </div>
      <ChangelogMonths />
    </div>
  );
}
