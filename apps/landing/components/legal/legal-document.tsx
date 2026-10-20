import type { ReactNode } from "react";
import Link from "next/link";
import Header from "@/components/layout/header";
import Footer from "@/components/layout/footer";
import { legalUpdatedAt, legalUpdatedLabel } from "@/lib/legal";
import { site } from "@/lib/site";

export interface LegalSection {
  id: string;
  title: string;
  content: ReactNode;
}

export function LegalContact() {
  return (
    <p>
      Contact LegionCode through the{" "}
      <a href={`${site.githubUrl}/issues/new/choose`}>
        project support tracker
      </a>
      . For a privacy, account-deletion, or legal request that involves
      confidential information, first ask for a private follow-up channel. Do
      not post credentials, private code, identity documents, or other sensitive
      personal information in a public issue.
    </p>
  );
}

export function LegalDocument({
  title,
  introduction,
  sections,
}: {
  title: string;
  introduction: string;
  sections: LegalSection[];
}) {
  return (
    <div className="min-h-screen bg-black font-sans text-zinc-100">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 pb-24 pt-12 sm:pt-20">
        <div className="mb-12 flex flex-wrap items-center justify-between gap-4 text-sm text-zinc-400">
          <span>LegionCode / Legal</span>
          <Link
            href="/agents/"
            prefetch={false}
            className="rounded-sm underline-offset-4 hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            Back to sign in
          </Link>
        </div>

        <header className="max-w-3xl">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            {title}
          </h1>
          <p className="mt-6 text-base leading-7 text-zinc-400 sm:text-lg sm:leading-8">
            {introduction}
          </p>
          <p className="mt-6 text-xs text-zinc-500">
            Last updated{" "}
            <time dateTime={legalUpdatedAt}>{legalUpdatedLabel}</time>
          </p>
        </header>

        <div className="mt-14 grid items-start gap-12 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16">
          <nav
            aria-label="On this page"
            className="hidden border-t border-white/10 pt-5 lg:sticky lg:top-28 lg:block"
          >
            <p className="mb-4 text-xs font-medium text-zinc-500">
              On this page
            </p>
            <ol className="space-y-3 text-sm leading-5 text-zinc-400">
              {sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="rounded-sm hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
                  >
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <article className="min-w-0 max-w-3xl space-y-12 text-[15px] leading-7 text-zinc-300 [&_a]:break-words [&_a]:text-zinc-100 [&_a]:underline [&_a]:decoration-zinc-600 [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-4 [&_a:focus-visible]:outline-white [&_a:hover]:decoration-white [&_li+li]:mt-2 [&_p+p]:mt-4 [&_strong]:font-medium [&_strong]:text-zinc-100 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
            {sections.map((section) => (
              <section
                id={section.id}
                key={section.id}
                aria-labelledby={`${section.id}-title`}
                className="scroll-mt-28 border-t border-white/10 pt-6"
              >
                <h2
                  id={`${section.id}-title`}
                  className="mb-4 text-xl font-semibold tracking-tight text-zinc-100"
                >
                  {section.title}
                </h2>
                {section.content}
              </section>
            ))}
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
