import type { Metadata } from "next";
import { site } from "./site";

export const legalUpdatedAt = "2026-10-20";
export const legalUpdatedLabel = "October 20, 2026";

export function legalMetadata(
  title: string,
  path: string,
  description: string,
): Metadata {
  return {
    title,
    description,
    alternates: { canonical: `${site.url}${path}` },
    openGraph: { title, description, url: `${site.url}${path}` },
  };
}
