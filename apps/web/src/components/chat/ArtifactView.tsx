import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface ArtifactViewProps {
  isOpen: boolean;
  title: string;
  content: string;
  language?: string;
  wordWrap?: boolean;
}

export function ArtifactView({
  isOpen,
  title,
  content,
  language,
  wordWrap = true,
}: ArtifactViewProps) {
  if (!isOpen) return null;

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
          customStyle={{
            margin: 0,
            width: '100%',
            background: 'transparent',
            padding: '1.5rem',
            fontSize: '13px',
            fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
          }}
          codeTagProps={{
            style: {
              background: 'transparent',
            }
          }}
        >
          {content}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

function getLanguage(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rs: 'rust', go: 'go', md: 'markdown', json: 'json',
    css: 'css', html: 'html',
  };
  return extension ? languages[extension] ?? 'typescript' : 'typescript';
}
