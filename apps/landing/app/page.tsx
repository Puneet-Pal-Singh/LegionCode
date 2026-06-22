import type { Metadata } from "next";
import React from "react";
import AnnouncementBanner from "@/components/layout/announcement-banner";
import Header from "@/components/layout/header";
import LandingHero from "@/components/hero/landing-hero";
import WorkspacePlayground from "@/components/playground/workspace-playground";
import FeaturesBento from "@/components/features/features-bento";
import ByokSection from "@/components/features/byok-section";
import SurfacesSection from "@/components/features/surfaces-section";
import ExperienceLiftoff from "@/components/features/experience-liftoff";
import Footer from "@/components/layout/footer";
import ProductJsonLd from "@/components/seo/product-json-ld";

export const metadata: Metadata = {
  title: { absolute: "LegionCode - Open-source multi-agent coding workspace" },
  description:
    "Connect a repository, launch parallel coding-agent runs in isolated workspaces, and review every diff before it reaches your main branch.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-black font-sans text-zinc-100 flex flex-col selection:bg-white selection:text-black antialiased overflow-x-hidden">
      <ProductJsonLd />

      {/* Top Announcement Banner */}
      <AnnouncementBanner />

      {/* HEADER SECTION - Minimal monochrome layout */}
      <Header />

      <main className="flex-grow flex flex-col">
        {/* CORE HERO SECTION */}
        <LandingHero />

        {/* WORKSPACE PLAYGROUND SECTION */}
        <WorkspacePlayground />

        {/* FEATURES GRID SECTION */}
        <FeaturesBento />

        {/* BRING YOUR OWN KEY SECTION */}
        <ByokSection />

        {/* CHOOSE YOUR AGENT WORKSPACE SECTION */}
        <SurfacesSection />

        {/* EXPERIENCE LIFTOFF SECTION - 3D Starfield Galaxy Graphics */}
        <ExperienceLiftoff />
      </main>

      {/* FINAL MINIMAL FOOTER */}
      <Footer />
    </div>
  );
}
