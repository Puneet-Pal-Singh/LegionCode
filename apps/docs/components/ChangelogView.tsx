"use client";

import { useMemo, useState } from "react";
import { changelogReleases } from "@/content/changelog";
import type {
  ChangelogCategory,
  ChangelogRelease,
  ChangelogSection,
} from "@/lib/changelog";
import { cn } from "@/lib/utils";

type CategoryFilter = "all" | ChangelogCategory;

interface ChangelogMonth {
  id: string;
  label: string;
  releases: ChangelogRelease[];
}

const categories: Array<{ id: CategoryFilter; label: string }> = [
  { id: "all", label: "All updates" },
  { id: "product", label: "Product" },
  { id: "providers", label: "Providers" },
  { id: "platform", label: "Platform" },
];

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function groupReleases(category: CategoryFilter): ChangelogMonth[] {
  const months = new Map<string, ChangelogMonth>();

  for (const release of changelogReleases) {
    const sections = release.sections.filter(
      (section) => category === "all" || section.category === category,
    );
    const highlights = release.highlights?.filter(
      (highlight) => category === "all" || highlight.category === category,
    );
    if (sections.length === 0 && !highlights?.length) continue;

    const monthKey = release.date.slice(0, 7);
    const date = new Date(`${monthKey}-01T00:00:00Z`);
    let month = months.get(monthKey);
    if (!month) {
      const label = monthFormatter.format(date);
      month = {
        // Preserve the existing #june-2026 launch-month link.
        id: label.toLowerCase().replace(" ", "-"),
        label,
        releases: [],
      };
      months.set(monthKey, month);
    }
    month.releases.push({ ...release, sections, highlights });
  }

  return [...months.values()];
}

function CategoryFilters({
  active,
  onChange,
}: {
  active: CategoryFilter;
  onChange: (category: CategoryFilter) => void;
}) {
  return (
    <div
      aria-label="Filter changelog updates"
      className="mb-10 flex flex-wrap gap-2"
    >
      {categories.map((category) => (
        <button
          key={category.id}
          type="button"
          onClick={() => onChange(category.id)}
          aria-pressed={active === category.id}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white",
            active === category.id
              ? "bg-white/10 text-white"
              : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200",
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
    <section className="space-y-3">
      <h4 className="text-sm font-semibold text-zinc-200">{section.title}</h4>
      <ul className="list-disc space-y-2 pl-4 text-sm leading-7 text-zinc-400 marker:text-zinc-600">
        {section.items.map((item) => (
          <li key={item} className="pl-1">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReleaseArticle({ release }: { release: ChangelogRelease }) {
  const hasHighlights = Boolean(release.highlights?.length);
  const sections = (
    <div className="space-y-6">
      {release.sections.map((section) => (
        <ReleaseSection
          key={`${section.category}-${section.title}`}
          section={section}
        />
      ))}
    </div>
  );

  return (
    <article
      id={release.id}
      aria-labelledby={`${release.id}-title`}
      className="grid scroll-mt-24 gap-3 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-6"
    >
      <div className="pt-1 sm:sticky sm:top-24 sm:self-start">
        <time
          dateTime={release.date}
          className="text-xs leading-6 text-zinc-500"
        >
          {dateFormatter.format(new Date(`${release.date}T00:00:00Z`))}
        </time>
        {(release.phase === "development" || release.pullRequests) && (
          <span className="ml-2 text-[10px] text-zinc-600 sm:ml-0 sm:block">
            {release.phase === "development" ? "Development" : "Merged"}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <h3
          id={`${release.id}-title`}
          className="text-xl font-semibold leading-snug tracking-tight text-white sm:text-[22px]"
        >
          <a
            href={`#${release.id}`}
            className="decoration-white/25 underline-offset-4 hover:underline"
          >
            {release.title}
          </a>
        </h3>
        {release.phase === "launch" && (
          <p className="mt-2 text-xs text-zinc-500">Private-alpha launch</p>
        )}
        {hasHighlights && (
          <ul aria-label="Highlights" className="mt-6 space-y-5">
            {release.highlights?.map((highlight) => (
              <li key={highlight.title}>
                <h4 className="text-sm font-semibold text-zinc-200">
                  {highlight.title}
                </h4>
                <p className="mt-1 text-sm leading-7 text-zinc-400">
                  {highlight.description}
                </p>
              </li>
            ))}
          </ul>
        )}
        {release.sections.length > 0 &&
          (hasHighlights ? (
            <details className="group mt-6">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-2 text-xs text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white [&::-webkit-details-marker]:hidden">
                More changes
                <svg
                  aria-hidden="true"
                  viewBox="0 0 12 12"
                  className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                >
                  <path d="m3 4.5 3 3 3-3" />
                </svg>
              </summary>
              <div className="mt-5">{sections}</div>
            </details>
          ) : (
            <div className="mt-5">{sections}</div>
          ))}
        {(release.pullRequests?.length || release.commits?.length) && (
          <nav
            aria-label={`Source changes for ${release.title}`}
            className="mt-5 flex flex-wrap gap-x-3 gap-y-2 text-xs"
          >
            {release.pullRequests?.map((number) => (
              <a
                key={number}
                href={`https://github.com/Puneet-Pal-Singh/LegionCode/pull/${number}`}
                className="text-zinc-600 underline decoration-white/10 underline-offset-4 transition-colors hover:text-zinc-300"
              >
                #{number}
              </a>
            ))}
            {release.commits?.map((sha) => (
              <a
                key={sha}
                href={`https://github.com/Puneet-Pal-Singh/LegionCode/commit/${sha}`}
                aria-label={`Commit ${sha.slice(0, 8)}`}
                className="font-mono text-zinc-600 underline decoration-white/10 underline-offset-4 transition-colors hover:text-zinc-300"
              >
                {sha.slice(0, 8)}
              </a>
            ))}
          </nav>
        )}
      </div>
    </article>
  );
}

function ChangelogMonths({ months }: { months: ChangelogMonth[] }) {
  return (
    <aside className="sticky top-24 hidden w-32 shrink-0 select-none xl:block">
      <nav
        aria-label="Changelog months"
        className="space-y-4 border-l border-white/10 py-1 pl-4"
      >
        {months.map((month) => (
          <a
            key={month.id}
            href={`#${month.id}`}
            className="block text-xs text-zinc-500 transition-colors hover:text-white"
          >
            {month.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

export function ChangelogView() {
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("all");
  const months = useMemo(() => groupReleases(activeCategory), [activeCategory]);

  return (
    <div className="relative flex w-full items-start gap-10 xl:gap-12">
      <div className="min-w-0 flex-1">
        <header className="mb-7">
          <h1 className="mb-2 text-3xl font-semibold tracking-tight text-white">
            Changelog
          </h1>
          <p className="text-sm leading-relaxed text-zinc-500">
            New features, improvements, and fixes in LegionCode.
          </p>
        </header>
        <CategoryFilters active={activeCategory} onChange={setActiveCategory} />
        <div className="space-y-14">
          {months.map((month) => (
            <section
              key={month.id}
              id={month.id}
              aria-labelledby={`${month.id}-title`}
              className="scroll-mt-24"
            >
              <h2
                id={`${month.id}-title`}
                className="mb-7 border-t border-white/10 pt-5 text-xs font-medium text-zinc-500"
              >
                {month.label}
              </h2>
              <div className="space-y-9 divide-y divide-white/[0.06] [&>article+article]:pt-9">
                {month.releases.map((release) => (
                  <ReleaseArticle key={release.id} release={release} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <p className="mt-10 border-t border-white/5 pt-5 text-xs leading-relaxed text-zinc-600">
          Entries before June 22, 2026 record development milestones, not public
          releases. Dates follow the source PRs and commits, not deployments.
        </p>
      </div>
      <ChangelogMonths months={months} />
    </div>
  );
}
