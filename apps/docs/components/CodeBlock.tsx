'use client';

import React, { useState, useId } from 'react';
import { Copy, Check } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language?: string;
  id?: string;
}

export function CodeBlock({ code, language = 'bash', id }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const reactGeneratedId = useId();
  const elementId = id ?? `codeblock-${reactGeneratedId.replace(/:/g, '')}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const lines = code.split('\n');

  return (
    <div 
      id={elementId}
      className="relative my-5 rounded-lg border border-white/10 bg-zinc-950 font-mono text-xs sm:text-sm leading-relaxed overflow-hidden shadow-lg group"
    >
      {/* Top Banner */}
      <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/5 text-zinc-450 text-[10px]">
        <span className="font-semibold tracking-wider uppercase text-zinc-450">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/10 hover:text-white text-zinc-500 transition-colors duration-150 relative z-10"
          aria-label="Copy code block"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-450 animate-in fade-in" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Area with line numbers */}
      <div className="p-4 overflow-x-auto text-zinc-300 selection:bg-zinc-800 selection:text-white">
        <pre className="font-mono text-xs sm:text-sm whitespace-pre">
          <code>
            {lines.map((line, idx) => (
              <div key={idx} className="flex leading-normal">
                <span className="text-zinc-600 mr-4 select-none text-right w-5 inline-block border-r border-white/5 pr-2">
                  {idx + 1}
                </span>
                <span>{line || ' '}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}

