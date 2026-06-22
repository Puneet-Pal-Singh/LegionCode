import Link from "next/link";
import { ArrowRight, BookOpen, GitBranch, Github, Layers3 } from "lucide-react";
import { DocsCard } from "@/components/DocsCard";

const guides = [
  {
    href: "/quickstart/",
    title: "Start a reviewed run",
    description:
      "Connect GitHub, select a repository and provider, and complete the private-alpha workflow.",
    icon: <BookOpen className="h-5 w-5 text-zinc-400" />,
  },
  {
    href: "/review/",
    title: "Understand the workflow",
    description:
      "Learn how runs, changed files, permissions, review, and explicit Git actions fit together.",
    icon: <GitBranch className="h-5 w-5 text-zinc-400" />,
  },
  {
    href: "/architecture/",
    title: "Explore the architecture",
    description:
      "See how Web, Brain, Muscle, execution contracts, and Postgres divide responsibility.",
    icon: <Layers3 className="h-5 w-5 text-zinc-400" />,
  },
] as const;

export default function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col justify-between overflow-hidden bg-black text-zinc-200">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#27272a_1px,transparent_1px),linear-gradient(to_bottom,#27272a_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-10 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
      <header className="relative z-10 mx-auto flex h-16 w-full max-w-7xl items-center justify-between border-b border-white/5 px-4 sm:px-6 lg:px-8">
        <Link
          href="/overview/"
          className="flex items-center gap-2 text-sm font-semibold text-white"
        >
          <span aria-hidden="true">&lt;|&gt;</span>
          <span>LegionCode Docs</span>
        </Link>
        <a
          href="https://github.com/Puneet-Pal-Singh/LegionCode"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded border border-white/5 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-400 hover:text-white"
        >
          <Github className="h-3.5 w-3.5" aria-hidden="true" /> GitHub
        </a>
      </header>
      <main className="relative z-10 mx-auto flex w-full max-w-5xl grow flex-col items-center justify-center px-4 py-16 text-center sm:px-6 sm:py-24">
        <div className="mb-6 inline-flex items-center rounded-full border border-cyan-900/40 bg-cyan-950/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-cyan-300 sm:text-xs">
          Private alpha · v0.1.0
        </div>
        <h1 className="mb-6 max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-6xl">
          Documentation for the LegionCode workspace.
        </h1>
        <p className="mb-8 max-w-2xl text-sm leading-relaxed text-zinc-400 sm:text-base md:text-lg">
          Product workflows, provider configuration, execution architecture, and
          operations guidance grounded in the current repository.
        </p>
        <div className="mb-16 flex w-full max-w-md flex-col justify-center gap-3.5 sm:flex-row">
          <Link
            href="/overview/"
            className="group flex items-center justify-center gap-1.5 rounded-md bg-white px-6 py-3 text-sm font-semibold text-black hover:bg-zinc-200"
          >
            Read the overview{" "}
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
          <Link
            href="/changelog/"
            className="flex items-center justify-center rounded-md border border-white/10 bg-black px-6 py-3 font-mono text-xs text-zinc-300 hover:border-white/25 hover:text-white"
          >
            Changelog
          </Link>
        </div>
        <div className="grid w-full max-w-4xl grid-cols-1 gap-4 text-left sm:grid-cols-3">
          {guides.map((guide) => (
            <Link key={guide.href} href={guide.href}>
              <DocsCard
                title={guide.title}
                description={guide.description}
                icon={guide.icon}
              />
            </Link>
          ))}
        </div>
      </main>
      <footer className="relative z-10 border-t border-white/5 py-6 text-center font-mono text-xs text-zinc-500">
        LegionCode documentation · MIT licensed
      </footer>
    </div>
  );
}
