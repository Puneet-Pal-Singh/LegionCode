import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cloud private alpha",
  description:
    "Run coding agents in isolated cloud workspaces and review their changes before merging.",
  alternates: { canonical: "/cloud/" },
  openGraph: {
    title: "LegionCode Cloud private alpha",
    description:
      "Run coding agents in isolated cloud workspaces and review their changes before merging.",
    url: "/cloud/",
  },
};

export default function CloudLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
