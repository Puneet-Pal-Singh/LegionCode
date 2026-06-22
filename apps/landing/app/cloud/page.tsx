import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import AnnouncementBanner from "@/components/layout/announcement-banner";
import Header from "@/components/layout/header";
import Footer from "@/components/layout/footer";
import CloudBackground from "@/components/cloud/cloud-background";
import LogoAscii from "@/components/logo/logo-ascii";
import WaitlistForm from "@/components/cloud/waitlist-form";

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
            <span className="underline underline-offset-4 decoration-zinc-650">
              cloud
            </span>{" "}
            ☁️
          </h1>

          {/* Private-alpha registration */}
          <div className="w-full max-w-md px-2 sm:px-0">
            <WaitlistForm />

            <p className="text-[11px] leading-relaxed font-mono text-zinc-500 mt-4 select-none px-4 sm:px-0">
              Use the email associated with your GitHub account. We will send
              access instructions after approval.
            </p>

            <div className="mt-6 pt-4 border-t border-white/[0.05]">
              <Link
                href="/agents/"
                className="inline-flex items-center gap-1.5 text-xs font-mono text-zinc-400 hover:text-white transition-all group"
              >
                <span>Already approved? Sign in to Cloud Agents</span>
                <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
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
