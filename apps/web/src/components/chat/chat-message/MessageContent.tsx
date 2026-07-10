import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../../lib/utils";
import {
  shortenTextMentions,
  visitMarkdownTextNodes,
} from "./markdownTransforms";

export function MarkdownMessageContent({
  content,
  isUser = false,
}: {
  content: string;
  isUser?: boolean;
}) {
  const remarkPlugins = isUser
    ? [remarkGfm, remarkShortenUserFileMentions]
    : [remarkGfm];

  return (
    <div
      className={cn(
        "break-words text-sm leading-relaxed",
        "[&_p]:m-0 [&_p+*]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
        "[&_hr]:my-4 [&_hr]:border-zinc-700/60 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic",
        "[&_code]:rounded [&_code]:border [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-sm [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1",
        isUser
          ? "text-white [&_blockquote]:border-zinc-400/60 [&_code]:border-zinc-700/85 [&_code]:bg-zinc-900/92 [&_pre]:bg-zinc-900/70 [&_th]:border-zinc-500/70 [&_td]:border-zinc-500/60"
          : "text-zinc-100 [&_blockquote]:border-zinc-600/80 [&_code]:border-zinc-700/90 [&_code]:bg-zinc-950/80 [&_th]:border-zinc-700/80 [&_td]:border-zinc-800/80",
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        disallowedElements={["img"]}
        components={{
          a: ({ node, className, ...props }) => {
            void node;
            return (
              <a
                {...props}
                target="_blank"
                rel="noreferrer noopener"
                className={cn(
                  "underline decoration-dotted underline-offset-2 transition-colors",
                  isUser
                    ? "text-zinc-100 hover:text-white"
                    : "text-emerald-300 hover:text-emerald-200",
                  className,
                )}
              />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function remarkShortenUserFileMentions() {
  return (tree: unknown) => visitMarkdownTextNodes(tree, shortenTextMentions);
}

export function MessageContent({
  content,
  isUser,
}: {
  content: string;
  isUser: boolean;
}): ReactNode {
  if (!content) return null;
  return isUser ? (
    <div className="inline-block bg-[#262626] text-white px-4 py-2.5 rounded-2xl text-sm leading-relaxed">
      <MarkdownMessageContent content={content} isUser />
    </div>
  ) : (
    <div className="space-y-3">
      <MarkdownMessageContent content={content} />
    </div>
  );
}
