import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DocsNavigationPage } from "@/lib/docs-navigation";

interface DocsPaginationProps {
  previous: DocsNavigationPage | null;
  next: DocsNavigationPage | null;
}

function PaginationLink({
  page,
  direction,
}: {
  page: DocsNavigationPage;
  direction: "previous" | "next";
}) {
  const isPrevious = direction === "previous";
  return (
    <Link
      href={`/${page.slug}/`}
      className={`group flex max-w-[45%] flex-col gap-1 rounded-lg border border-white/5 bg-zinc-950/50 p-3 transition-all hover:border-white/10 hover:bg-zinc-900/40 ${
        isPrevious ? "items-start" : "items-end text-right"
      }`}
    >
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 group-hover:text-zinc-400">
        {isPrevious && <ChevronLeft className="h-3 w-3" aria-hidden="true" />}
        {isPrevious ? "Previous" : "Next"}
        {!isPrevious && <ChevronRight className="h-3 w-3" aria-hidden="true" />}
      </span>
      <span className="w-full truncate text-xs font-semibold text-zinc-300 group-hover:text-white sm:text-sm">
        {page.title}
      </span>
    </Link>
  );
}

export function DocsPagination({ previous, next }: DocsPaginationProps) {
  return (
    <div className="mt-12 flex items-center justify-between border-t border-white/10 pt-8">
      {previous ? (
        <PaginationLink page={previous} direction="previous" />
      ) : (
        <div />
      )}
      {next ? <PaginationLink page={next} direction="next" /> : <div />}
    </div>
  );
}
