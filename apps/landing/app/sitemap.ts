import type { MetadataRoute } from "next";
import { docsRoutes, site } from "@/lib/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const productRoutes: MetadataRoute.Sitemap = [
    {
      url: site.url,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${site.url}/cloud/`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
  const documentationRoutes: MetadataRoute.Sitemap = docsRoutes.map(
    (route) => ({
      url: `${site.url}/docs/${route}/`,
      changeFrequency: route === "changelog" ? "weekly" : "monthly",
      priority: route === "overview" ? 0.8 : 0.6,
    }),
  );
  return [...productRoutes, ...documentationRoutes];
}
