import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { site } from "@/lib/site";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: "LegionCode - Open-source coding-agent workspace",
    template: "%s | LegionCode",
  },
  description: site.description,
  applicationName: site.name,
  alternates: { canonical: "/" },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/assets/legioncode-icon.svg", type: "image/svg+xml" },
      {
        url: "/assets/legioncode-icon-32.png",
        sizes: "32x32",
        type: "image/png",
      },
    ],
    apple: "/assets/legioncode-icon-192.png",
  },
  openGraph: {
    title: "LegionCode - Open-source coding-agent workspace",
    description: site.description,
    url: "/",
    siteName: site.name,
    type: "website",
    images: [
      { url: site.ogImage, width: 1200, height: 1200, alt: "LegionCode" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "LegionCode - Open-source coding-agent workspace",
    description: site.description,
    images: [site.ogImage],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable} dark`}
      suppressHydrationWarning
    >
      <head>
        <meta name="darkreader-lock" />
      </head>
      <body
        className="bg-black text-zinc-100 antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
