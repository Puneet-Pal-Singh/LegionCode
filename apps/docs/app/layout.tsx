import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css'; // Global styles

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'LegionCode Docs — Web-Native Coding-Agent Workspace',
  description: 'Documentation portal for LegionCode: An open-source web-native coding-agent workspace built on isolated Cloudflare-native sandboxes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} scroll-smooth`}>
      <body suppressHydrationWarning className="bg-black font-sans text-stone-150 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}

