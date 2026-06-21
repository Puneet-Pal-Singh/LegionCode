import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { CODE_TYPOGRAPHY_STYLE } from "../../lib/codeTypography";

interface ArtifactViewProps {
  isOpen: boolean;
  title: string;
  content: string;
  language?: string;
  wordWrap?: boolean;
  richPreview?: boolean;
}

export function ArtifactView({
  isOpen,
  title,
  content,
  language,
  wordWrap = true,
  richPreview = false,
}: ArtifactViewProps) {
  if (!isOpen) return null;

  if (richPreview && isMarkdown(title)) {
    return (
      <div className="h-full overflow-auto bg-black px-6 py-5 text-zinc-200 scrollbar-hide">
        <article
          className={cn(
            "max-w-none break-words text-sm leading-7",
            "[&_h1]:mb-4 [&_h1]:mt-2 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:text-white",
            "[&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:border-b [&_h2]:border-zinc-800 [&_h2]:pb-2 [&_h2]:text-2xl [&_h2]:font-semibold",
            "[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold",
            "[&_p]:my-3 [&_a]:text-emerald-300 [&_a]:underline [&_a]:underline-offset-2",
            "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
            "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-4 [&_blockquote]:italic",
            "[&_code]:rounded [&_code]:bg-zinc-900 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]",
            "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
            "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-zinc-700 [&_th]:px-3 [&_th]:py-2 [&_td]:border [&_td]:border-zinc-800 [&_td]:px-3 [&_td]:py-2",
            "[&_img]:my-4 [&_img]:max-w-full [&_img]:rounded-lg",
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </article>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex-1 overflow-auto scrollbar-hide">
        <SyntaxHighlighter
          language={language ?? getLanguage(title)}
          style={vscDarkPlus}
          PreTag="div"
          showLineNumbers={true}
          wrapLongLines={wordWrap}
          wrapLines={wordWrap}
          lineProps={{
            style: {
              display: "block",
              whiteSpace: wordWrap ? "pre-wrap" : "pre",
              overflowWrap: wordWrap ? "anywhere" : "normal",
              wordBreak: "normal",
            },
          }}
          customStyle={{
            margin: 0,
            width: "100%",
            background: "transparent",
            padding: "1.5rem",
            ...CODE_TYPOGRAPHY_STYLE,
            fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
          }}
          codeTagProps={{
            style: {
              ...CODE_TYPOGRAPHY_STYLE,
              background: "transparent",
              whiteSpace: wordWrap ? "pre-wrap" : "pre",
              overflowWrap: wordWrap ? "anywhere" : "normal",
              wordBreak: "normal",
            },
          }}
        >
          {content}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

function isMarkdown(filename: string): boolean {
  return /\.mdx?$/i.test(filename);
}

function getLanguage(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rs: "rust",
    go: "go",
    md: "markdown",
    json: "json",
    css: "css",
    html: "html",
  };
  return extension ? (languages[extension] ?? "typescript") : "typescript";
}
