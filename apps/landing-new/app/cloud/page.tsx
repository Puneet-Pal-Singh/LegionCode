import Link from "next/link";
import { ArrowUpRight, Github } from "lucide-react";
import AnnouncementBanner from "@/components/layout/announcement-banner";
import Header from "@/components/layout/header";
import Footer from "@/components/layout/footer";
import CloudBackground from "@/components/cloud/cloud-background";
import LogoAscii from "@/components/logo/logo-ascii";
import { site } from "@/lib/site";

export default function CloudPage() {
  return (
    <div className="min-h-screen bg-black font-sans text-zinc-100 flex flex-col selection:bg-white selection:text-black antialiased overflow-hidden relative">
      {/* BACKGROUND ASCII DEBRIS & TEXTURE WALL */}
      <CloudBackground />

      {/* Top Announcement Banner */}
      <AnnouncementBanner />

      {/* HEADER SECTION - Minimal monochrome layout */}
      <Header />

      {/* CLOUD CENTRAL HERO (Perfect visual reproduction of the screenshot) */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 sm:px-6 sm:py-20 relative z-10">
        <div className="max-w-4xl w-full mx-auto flex flex-col items-center text-center">
          {/* EARLY ACCESS badge (in a subtle grey box) */}
          <div className="px-3 py-1 rounded border border-white/15 bg-zinc-900/60 text-zinc-400 font-mono text-[10px] tracking-[0.2em] uppercase mb-8 select-none">
            Early Access
          </div>

          {/* Large Brand Lockup using custom high-fidelity responsive layout */}
          <LogoAscii badge="Cloud" />

          {/* Hero Headline */}
          <h1 className="font-sans text-[13px] min-[360px]:text-[14px] min-[400px]:text-base sm:text-lg md:text-xl lg:text-[22px] text-zinc-100 tracking-tight font-medium mb-10 px-2 sm:px-0 whitespace-nowrap">
            Run a team of coding agents in the{" "}
            <span className="underline underline-offset-4 decoration-zinc-650 cursor-pointer hover:decoration-white transition-colors">
              cloud
            </span>{" "}
            ☁️
          </h1>

          {/* Private-alpha entry point */}
          <div className="w-full max-w-md px-2 sm:px-0">
            <div className="flex flex-col sm:flex-row items-center gap-2.5 sm:gap-2">
              <Link
                href="/agents/"
                className="w-full bg-white text-black hover:bg-zinc-200 px-5 py-3 rounded-lg text-xs font-mono transition-colors inline-flex items-center justify-center gap-2 font-medium"
              >
                <span>Open Cloud Agents</span>
                <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
              </Link>
              <a
                href={site.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full bg-zinc-950/70 border border-white/10 text-zinc-200 hover:bg-zinc-900 px-5 py-3 rounded-lg text-xs font-mono transition-colors inline-flex items-center justify-center gap-2"
              >
                <Github className="w-3.5 h-3.5" aria-hidden="true" />
                <span>View source</span>
              </a>
            </div>

            <p className="text-[11px] leading-relaxed font-mono text-zinc-500 mt-4 select-none px-4 sm:px-0">
              Private alpha uses GitHub sign-in. Capacity may be limited while
              cloud execution scales.
            </p>

            <div className="mt-6 pt-4 border-t border-white/[0.05]">
              <Link
                href="/docs/"
                className="inline-flex items-center gap-1.5 text-xs font-mono text-zinc-400 hover:text-white transition-all group"
              >
                <span>Read the documentation</span>
                <span className="transform group-hover:translate-x-0.5 transition-transform">
                  →
                </span>
              </Link>
            </div>
          </div>
        </div>
      </main>

      {/* MIT LOWER BAR FOOTER */}
      <Footer />
    </div>
  );
}
