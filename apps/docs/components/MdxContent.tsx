import type { ComponentProps, ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import Link from "next/link";
import type { MDXComponents } from "mdx/types";
import { CodeBlock } from "@/components/CodeBlock";
import { Callout } from "@/components/Callout";
import { DocsCard } from "@/components/DocsCard";

function MdxLink({ href = "", children, ...props }: ComponentProps<"a">) {
  const className =
    "text-blue-400 underline underline-offset-4 hover:text-blue-300";
  if (href.startsWith("/docs/")) {
    return (
      <Link href={href.slice("/docs".length)} className={className}>
        {children}
      </Link>
    );
  }

  if (href.startsWith("/")) {
    return (
      <a href={href} className={className} {...props}>
        {children}
      </a>
    );
  }

  return (
    <a href={href} className={className} rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

function readCodeChild(
  children: ReactNode,
): { code: string; language: string } | null {
  if (!isValidElement(children)) {
    return null;
  }

  const child = children as ReactElement<{
    children?: ReactNode;
    className?: string;
  }>;
  if (typeof child.props.children !== "string") {
    return null;
  }

  return {
    code: child.props.children.replace(/\n$/, ""),
    language: child.props.className?.replace("language-", "") || "text",
  };
}

function MdxPre({ children }: ComponentProps<"pre">) {
  const code = readCodeChild(children);
  if (code) {
    return <CodeBlock code={code.code} language={code.language} />;
  }
  return <pre>{children}</pre>;
}

export const mdxComponents: MDXComponents = {
  h2: ({ children, ...props }) => (
    <h2
      {...props}
      className="scroll-mt-20 border-b border-white/5 pb-2 pt-6 text-xl font-bold tracking-tight text-white sm:text-2xl"
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3
      {...props}
      className="scroll-mt-20 pt-4 text-base font-bold tracking-tight text-zinc-200 sm:text-lg"
    >
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="text-sm leading-7 text-zinc-300 sm:text-base">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-4 list-disc space-y-2.5 pl-6 text-sm leading-7 text-zinc-300 sm:text-base">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 list-decimal space-y-2.5 pl-6 text-sm leading-7 text-zinc-300 sm:text-base">
      {children}
    </ol>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-white">{children}</strong>
  ),
  a: MdxLink,
  pre: MdxPre,
  table: ({ children }) => (
    <div className="my-8 overflow-x-auto rounded-lg border border-white/5 bg-zinc-950/40">
      <table className="w-full border-collapse text-left text-xs sm:text-sm">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-white/5 bg-white/5 text-[10px] uppercase tracking-wider text-zinc-400">
      {children}
    </thead>
  ),
  th: ({ children }) => (
    <th className="px-4 py-3.5 font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-3.5 leading-relaxed text-zinc-300">{children}</td>
  ),
  Callout,
  DocsCard,
};

export function MdxContent({ children }: { children: ReactNode }) {
  return <div className="docs-mdx space-y-6">{children}</div>;
}
