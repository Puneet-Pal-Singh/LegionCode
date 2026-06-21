import React from 'react';
import { notFound } from 'next/navigation';
import { docsPages, sidebarStructure } from '@/lib/docs-data';
import { DocsLayout } from '@/components/DocsLayout';
import { PageHeader } from '@/components/PageHeader';
import { CodeBlock } from '@/components/CodeBlock';
import { Callout } from '@/components/Callout';
import { DocsCard } from '@/components/DocsCard';
import { ChangelogView } from '@/components/ChangelogView';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, CornerDownRight, ArrowRight } from 'lucide-react';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return Object.keys(docsPages).map((slug) => ({
    slug,
  }));
}

export default async function DocPage({ params }: PageProps) {
  const { slug } = await params;
  const page = docsPages[slug];

  if (!page) {
    notFound();
  }

  // Flatten sidebar to compute Prev/Next navigation items
  const flatPages = sidebarStructure.flatMap((cat) => cat.pages);
  const currentIndex = flatPages.findIndex((p) => p.slug === slug);
  const prevPage = currentIndex > 0 ? flatPages[currentIndex - 1] : null;
  const nextPage = currentIndex < flatPages.length - 1 ? flatPages[currentIndex + 1] : null;

  if (slug === 'changelog') {
    return (
      <DocsLayout toc={[]} activeSlug={slug}>
        <ChangelogView />

        {/* Bottom Previous / Next Pagination Links */}
        <div className="flex items-center justify-between mt-12 pt-8 border-t border-white/10" id="docs-page-pagination">
          {prevPage ? (
            <Link
              href={`/docs/${prevPage.slug}`}
              className="group flex flex-col items-start gap-1 p-3 rounded-lg border border-white/5 bg-zinc-950/50 hover:bg-zinc-900/40 hover:border-white/10 transition-all duration-150 max-w-[45%]"
              id="pagination-prev"
            >
              <span className="flex items-center gap-1 text-[10px] font-mono tracking-wider uppercase text-zinc-500 group-hover:text-zinc-400 transition-colors">
                <ChevronLeft className="w-3 h-3" />
                Previous
              </span>
              <span className="text-xs sm:text-sm font-semibold text-zinc-300 group-hover:text-white transition-colors truncate w-full">
                {prevPage.title}
              </span>
            </Link>
          ) : (
            <div />
          )}

          {nextPage ? (
            <Link
              href={`/docs/${nextPage.slug}`}
              className="group flex flex-col items-end gap-1 p-3 rounded-lg border border-white/5 bg-zinc-950/50 hover:bg-zinc-900/40 hover:border-white/10 transition-all duration-150 text-right max-w-[45%]"
              id="pagination-next"
            >
              <span className="flex items-center gap-1 text-[10px] font-mono tracking-wider uppercase text-zinc-500 group-hover:text-zinc-400 transition-colors font-semibold">
                Next
                <ChevronRight className="w-3 h-3" />
              </span>
              <span className="text-xs sm:text-sm font-semibold text-zinc-300 group-hover:text-white transition-colors truncate w-full">
                {nextPage.title}
              </span>
            </Link>
          ) : (
            <div />
          )}
        </div>
      </DocsLayout>
    );
  }

  return (
    <DocsLayout toc={page.toc} activeSlug={slug}>
      {/* Page Heading & Status Header */}
      <PageHeader
        title={page.title}
        description={page.description}
        category={page.category}
        status={page.status}
      />

      {/* Primary Page Element Generator */}
      <div className="space-y-6" id="docs-body-flow">
        {page.elements.map((el, idx) => {
          switch (el.type) {
            case 'paragraph':
              return (
                <p key={idx} className="text-zinc-300 leading-relaxed text-sm sm:text-base font-sans">
                  {el.text}
                </p>
              );

            case 'heading':
              if (el.level === 2) {
                return (
                  <h2
                    key={idx}
                    id={el.id}
                    className="text-xl sm:text-2xl font-bold tracking-tight text-white mt-10 mb-4 pb-2 border-b border-white/5 scroll-mt-20 flex items-center gap-2"
                  >
                    <CornerDownRight className="w-4 h-4 text-zinc-500" />
                    {el.text}
                  </h2>
                );
              } else {
                return (
                  <h3
                    key={idx}
                    id={el.id}
                    className="text-base sm:text-lg font-bold tracking-tight text-zinc-200 mt-8 mb-3 scroll-mt-20"
                  >
                    {el.text}
                  </h3>
                );
              }

            case 'code':
              return <CodeBlock key={idx} code={el.code} language={el.language || 'bash'} id={`code-${idx}`} />;

            case 'callout':
              return (
                <Callout key={idx} variant={el.variant} title={el.title} className="my-6">
                  {el.text}
                </Callout>
              );

            case 'list':
              return (
                <ul key={idx} className="my-4 pl-6 list-disc space-y-2.5 text-zinc-300 text-sm sm:text-base leading-relaxed font-sans">
                  {el.items.map((item, ii) => (
                    <li key={ii} className="pl-1">
                      {item}
                    </li>
                  ))}
                </ul>
              );

            case 'table':
              return (
                <div key={idx} className="my-8 overflow-x-auto rounded-lg border border-white/5 bg-zinc-950/40">
                  <table className="w-full text-left border-collapse text-xs sm:text-sm">
                    <thead>
                      <tr className="border-b border-white/5 bg-white/5 text-zinc-400 font-mono text-[10px] uppercase tracking-wider">
                        {el.headers.map((h, hi) => (
                          <th key={hi} className="px-4 py-3.5 font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 font-sans text-zinc-300">
                      {el.rows.map((row, ri) => (
                        <tr key={ri} className="hover:bg-white/5 transition-colors">
                          {row.map((cell, ci) => (
                            <td key={ci} className="px-4 py-3.5 leading-relaxed truncate max-w-xs sm:max-w-lg">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );

            case 'features':
              return (
                <div key={idx} className="my-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {el.items.map((item, itemIdx) => (
                    <DocsCard
                      key={itemIdx}
                      title={item.title}
                      description={item.desc}
                      icon={item.icon}
                    />
                  ))}
                </div>
              );

            default:
              return null;
          }
        })}
      </div>

      {/* Bottom Previous / Next Pagination Links */}
      <div className="flex items-center justify-between mt-12 pt-8 border-t border-white/10" id="docs-page-pagination">
        {prevPage ? (
          <Link
            href={`/docs/${prevPage.slug}`}
            className="group flex flex-col items-start gap-1 p-3 rounded-lg border border-white/5 bg-zinc-950/50 hover:bg-zinc-900/40 hover:border-white/10 transition-all duration-150 max-w-[45%]"
            id="pagination-prev"
          >
            <span className="flex items-center gap-1 text-[10px] font-mono tracking-wider uppercase text-zinc-500 group-hover:text-zinc-400 transition-colors">
              <ChevronLeft className="w-3 h-3" />
              Previous
            </span>
            <span className="text-xs sm:text-sm font-semibold text-zinc-300 group-hover:text-white transition-colors truncate w-full">
              {prevPage.title}
            </span>
          </Link>
        ) : (
          <div />
        )}

        {nextPage ? (
          <Link
            href={`/docs/${nextPage.slug}`}
            className="group flex flex-col items-end gap-1 p-3 rounded-lg border border-white/5 bg-zinc-950/50 hover:bg-zinc-900/40 hover:border-white/10 transition-all duration-150 text-right max-w-[45%]"
            id="pagination-next"
          >
            <span className="flex items-center gap-1 text-[10px] font-mono tracking-wider uppercase text-zinc-500 group-hover:text-zinc-400 transition-colors font-semibold">
              Next
              <ChevronRight className="w-3 h-3" />
            </span>
            <span className="text-xs sm:text-sm font-semibold text-zinc-300 group-hover:text-white transition-colors truncate w-full">
              {nextPage.title}
            </span>
          </Link>
        ) : (
          <div />
        )}
      </div>
    </DocsLayout>
  );
}
