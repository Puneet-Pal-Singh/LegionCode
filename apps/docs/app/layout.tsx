import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  metadataBase: new URL("https://legioncode.dev"),
  title: {
    default: "LegionCode Documentation",
    template: "%s | LegionCode Docs",
  },
  description:
    "Product, architecture, provider, and operations documentation for LegionCode.",
  icons: {
    icon: [
      { url: "/assets/legioncode-icon.svg", type: "image/svg+xml" },
      {
        url: "/assets/legioncode-icon-32.png",
        sizes: "32x32",
        type: "image/png",
      },
    ],
  },
  openGraph: {
    title: "LegionCode Documentation",
    description:
      "Product, architecture, provider, and operations documentation for LegionCode.",
    url: "/docs/",
    siteName: "LegionCode",
    type: "website",
    images: [
      {
        url: "/assets/legioncode-og.png",
        width: 1200,
        height: 1200,
        alt: "LegionCode",
      },
    ],
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
      className={`${inter.variable} ${jetbrainsMono.variable} scroll-smooth`}
    >
      <body
        suppressHydrationWarning
        className="bg-black font-sans text-stone-150 antialiased min-h-screen"
      >
        {children}
      </body>
    </html>
  );
}
