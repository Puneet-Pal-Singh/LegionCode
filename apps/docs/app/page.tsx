import type { Metadata } from "next";
import { renderDocPage } from "@/app/[slug]/page";

export const metadata: Metadata = {
  title: "Overview",
  description:
    "Learn how LegionCode runs isolated coding-agent tasks and supports review-first repository workflows.",
  alternates: { canonical: "/docs/" },
};

export default function DocsHomePage() {
  return renderDocPage("overview");
}
