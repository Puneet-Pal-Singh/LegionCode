import type { Metadata } from "next";
import { ChangelogView } from "@/components/ChangelogView";
import { DocsLayout } from "@/components/DocsLayout";
import { getDocsSearchPages } from "@/lib/docs-content";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Product updates and release notes for LegionCode.",
  alternates: { canonical: "/docs/changelog/" },
};

export default async function ChangelogPage() {
  const searchPages = await getDocsSearchPages();
  return (
    <DocsLayout searchPages={searchPages}>
      <ChangelogView />
    </DocsLayout>
  );
}
