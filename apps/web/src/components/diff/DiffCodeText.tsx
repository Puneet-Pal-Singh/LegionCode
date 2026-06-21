import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { CODE_TYPOGRAPHY_STYLE } from "../../lib/codeTypography";

interface DiffCodeTextProps {
  content: string;
  language: string;
  wrap?: boolean;
}

export function DiffCodeText({
  content,
  language,
  wrap = false,
}: DiffCodeTextProps) {
  const whiteSpace = wrap ? "pre-wrap" : "pre";
  return (
    <SyntaxHighlighter
      language={language}
      style={vscDarkPlus}
      PreTag="span"
      CodeTag="span"
      customStyle={{
        ...CODE_TYPOGRAPHY_STYLE,
        display: "inline",
        margin: 0,
        padding: 0,
        background: "transparent",
        overflow: "visible",
        whiteSpace,
      }}
      codeTagProps={{
        style: {
          ...CODE_TYPOGRAPHY_STYLE,
          display: "inline",
          whiteSpace,
          wordBreak: wrap ? "break-word" : "normal",
          background: "transparent",
        },
      }}
    >
      {content}
    </SyntaxHighlighter>
  );
}
