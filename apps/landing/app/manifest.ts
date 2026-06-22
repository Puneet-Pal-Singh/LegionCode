import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LegionCode",
    short_name: "LegionCode",
    description:
      "Open-source workspace for isolated coding-agent runs and review-first changes.",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      {
        src: "/assets/legioncode-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/assets/legioncode-icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/assets/legioncode-icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
