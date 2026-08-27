'use client';

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, X, FileCode } from 'lucide-react';
import { MockTask, DiffLine } from './types';

interface ReviewPanelProps {
  activeTask: MockTask;
  selectedFile: string;
  onSelectFile: (fileName: string) => void;
  isRightSidebarOpen: boolean;
  setIsRightSidebarOpen: (open: boolean) => void;
  onUserInteract: () => void;
  activeTab?: 'review' | 'code';
  setActiveTab?: (tab: 'review' | 'code') => void;
}

const FILE_CONTENTS: Record<string, string> = {
  'apps/web/components/repo-picker.tsx': `'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { connectGithubRepository, fetchBranches } from '@/lib/github';
import { Button } from '@/components/ui/button';

export function RepositoryPicker() {
  const { user, isAuthenticated } = useAuth();
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState("main");
  const [repositories, setRepositories] = useState<any[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<any>(null);

  useEffect(() => {
    if (isAuthenticated) {
      fetchUserRepos().then(setRepositories);
    }
  }, [isAuthenticated]);

  async function handleConnect(repoId: string) {
    try {
      const repo = await connectGithubRepository(repoId);
      const branchList = await fetchBranches(repo.id);
      setBranches(branchList);
      setSelectedRepository(repo);
    } catch (err: any) {
      console.error("Failed to connect repository:", err);
    }
  }

  return (
    <div className="w-full max-w-xl mx-auto p-6 space-y-4 rounded-xl border border-white/10 bg-zinc-900/50">
      <h2 className="text-lg font-semibold text-white">Connect GitHub Repository</h2>
      <p className="text-sm text-zinc-400">Select a repository and target branch to initialize the workspace.</p>
      
      <div className="space-y-2">
        <label className="text-xs font-mono text-zinc-400">Repository</label>
        <select 
          value={selectedRepository?.id || ''}
          onChange={(e) => handleConnect(e.target.value)}
          className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-2 text-sm text-white"
        >
          <option value="">Select a repository...</option>
          {repositories.map(r => (
            <option key={r.id} value={r.id}>{r.full_name}</option>
          ))}
        </select>
      </div>

      {branches.length > 0 && (
        <div className="space-y-2">
          <label className="text-xs font-mono text-zinc-400">Default Branch</label>
          <select 
            value={selectedBranch}
            onChange={(e) => setSelectedBranch(e.target.value)}
            className="w-full bg-zinc-800 border border-white/10 rounded px-3 py-2 text-sm text-white"
          >
            {branches.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
      )}

      <Button className="w-full mt-4 bg-emerald-500 hover:bg-emerald-600 text-black font-medium">
        Initialize Workspace
      </Button>
    </div>
  );
}`,

  'apps/web/app/onboarding/page.tsx': `'use client';

import React from 'react';
import { RepositoryPicker } from '@/components/repo-picker';
import { OnboardingHeader } from '@/components/onboarding-header';

export default function OnboardingPage() {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6">
      <OnboardingHeader 
        title="Welcome to LegionCode"
        subtitle="Connect your repository to begin automated workspace provisioning."
      />
      
      <div className="w-full max-w-2xl mt-8">
        <RepositoryPicker />
      </div>
    </main>
  );
}`,

  'apps/web/lib/github.ts': `import { Octokit } from '@octokit/rest';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export async function connectGithubRepository(repoId: string) {
  const [owner, repo] = repoId.split('/');
  const { data } = await octokit.repos.get({
    owner,
    repo,
  });
  
  return {
    id: data.id,
    name: data.name,
    full_name: data.full_name,
    default_branch: data.default_branch,
    private: data.private,
  };
}

export async function fetchBranches(repoId: string) {
  const [owner, repo] = repoId.split('/');
  const { data } = await octokit.repos.listBranches({
    owner,
    repo,
  });
  
  return data.map((b) => b.name);
}`,

  'apps/secure-agent-api/src/index.ts': `import express from 'express';
import { createSandboxRuntime } from './sandbox';

const app = express();
app.use(express.json());

app.get('/api/debug/runtime', async (req, res) => {
  const runtime = await createSandboxRuntime({
    isolation: 'isolate-v8',
    memoryLimitMb: 512,
  });

  res.json({
    status: '200 OK',
    runtimeId: runtime.id,
    isolated: true,
  });
});

app.listen(3000, () => {
  console.log('Secure Agent API running on port 3000');
});`,

  'apps/secure-agent-api/src/sandbox.ts': `export interface SandboxConfig {
  isolation: 'isolate-v8' | 'gvisor';
  memoryLimitMb: number;
}

export async function createSandboxRuntime(config: SandboxConfig) {
  const runtimeId = 'sbx_' + Math.random().toString(36).substring(2, 9);
  
  return {
    id: runtimeId,
    config,
    created: new Date().toISOString(),
    status: 'running',
  };
}`,

  'README.md': `# LegionCode AI Agent

LegionCode is an autonomous AI developer environment designed for high-velocity software delivery.

## Features
- **Automated Repository Onboarding**: Connect GitHub repos and branches in seconds.
- **Secure Sandbox Execution**: Isolated worker environments with real-time verification checks.
- **Interactive Review Panel**: Side-by-side git diff review and full-file code viewing with line numbers.

## Getting Started
\`\`\`bash
pnpm install
pnpm dev
\`\`\`
`,

  'docs/architecture.md': `# Architecture Overview

This document outlines the system topology and runtime guarantees for LegionCode.

## Topology
1. **Web Frontend**: Next.js 15 App Router interface.
2. **Agent Engine**: Server-side agent coordinator orchestrating tool executions.
3. **Sandbox Worker**: Isolated Cloudflare Worker sandbox v1.4.
`,

  'package.json': `{
  "name": "legioncode",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "check:boundaries": "dependency-cruiser --config .dependency-cruiser.json src"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "lucide-react": "^0.450.0"
  }
}`,

  '.dependency-cruiser.json': `{
  "forbidden": [
    {
      "name": "no-circular",
      "severity": "error",
      "from": {},
      "to": { "circular": true }
    }
  ]
}`,

  'sequence_alignment.py': `#!/usr/bin/env python3

from bio.sequence_alignment import nw_align
from bio.fasta import parse_fasta
from bio.translate import translate

seq1 = "AGTACGCA"
seq2 = "TATGC"

print(f"Sequence 1: {seq1}")
print(f"Sequence 2: {seq2}")
print(f"NW Score: {nw_align(seq1, seq2)}")

fasta_data = """">NM_001126114.2 Homo sapiens tumor protein p53
ATGGAGGAGCCGCAGTCAGATCCTAGCGTCGAGCCCCCTCTGAGTCAGGAAACATTTTCAGACCTAT
AAACTACTTCCTGAAAACAACGTTCTGTCCCCCTTGCCGTCCCAAGCAATGGATGATTTGATGCTGT
>NM_000546.6 Homo sapiens TP53 variant 2
ATGGAGGAGCCGCAGTCAGATCCTAGCGTCGAGCCCCCTCTGAGTCAGGAAACATTTTCAGACCTAT
"""

print("\\nParsing FASTA:")
sequences = parse_fasta(fasta_data)
for name, seq in sequences:
    print(f">{name}")
    print(f"Length: {len(seq)}")
    print(f"Protein: {translate(seq)[:20]}...")`,

  'test_alignment.py': `#!/usr/bin/env python3

import unittest
from bio.sequence_alignment import nw_align

class TestSequenceAlignment(unittest.TestCase):
    def test_exact_match(self):
        score = nw_align("GATTACA", "GATTACA")
        self.assertGreater(score, 0)

    def test_mismatch_and_gap(self):
        score = nw_align("AGTACGCA", "TATGC")
        self.assertIsNotNone(score)

if __name__ == "__main__":
    unittest.main()`
};

function renderSyntaxTokens(line: string) {
  if (!line) return <span className="inline-block">&nbsp;</span>;

  const trimmed = line.trim();

  // Full Line Comments
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return <span className="text-zinc-500 italic">{line}</span>;
  }

  // Tokenizer regex
  const tokenRegex = /(".*?"|'.*?'|`.*?`|\/\/.+$|#[^#].*$|\b(?:import|from|export|default|function|const|let|var|return|async|await|try|catch|def|class|if|else|for|in|type|interface|use|print|self|len|assert|raise)\b|\b\d+\b|[a-zA-Z0-9_]+|[^\s\a-zA-Z0-9_]+|\s+)/g;

  const tokens = line.match(tokenRegex) || [line];

  return (
    <span>
      {tokens.map((token, idx) => {
        // Keywords
        if (/^(import|from|export|default|function|const|let|var|return|async|await|try|catch|def|class|if|else|for|in|type|interface|print|self|len|assert|raise)$/.test(token)) {
          return <span key={idx} className="text-pink-400 font-medium">{token}</span>;
        }
        // Strings
        if (/^(".*?"|'.*?'|`.*?`)$/.test(token)) {
          return <span key={idx} className="text-amber-300">{token}</span>;
        }
        // Numbers
        if (/^\d+$/.test(token)) {
          return <span key={idx} className="text-purple-300">{token}</span>;
        }
        // Inline Comments
        if (/^(\/\/|#).*$/.test(token)) {
          return <span key={idx} className="text-zinc-500 italic">{token}</span>;
        }
        // Types or capitalized components
        if (/^[A-Z][a-zA-Z0-9_]*$/.test(token)) {
          return <span key={idx} className="text-sky-300">{token}</span>;
        }
        // Punctuation
        if (/^[^\s\a-zA-Z0-9_]+$/.test(token)) {
          return <span key={idx} className="text-zinc-400">{token}</span>;
        }
        return <span key={idx} className="text-zinc-200">{token}</span>;
      })}
    </span>
  );
}

export default function ReviewPanel({
  activeTask,
  selectedFile,
  onSelectFile,
  isRightSidebarOpen,
  setIsRightSidebarOpen,
  onUserInteract,
  activeTab: propsActiveTab,
  setActiveTab: propsSetActiveTab,
}: ReviewPanelProps) {
  const [internalTab, setInternalTab] = useState<'review' | 'code'>('review');
  const activeTab = propsActiveTab ?? internalTab;
  const setActiveTab = propsSetActiveTab ?? setInternalTab;

  const [diffMode, setDiffMode] = useState<'unified' | 'split'>('unified');
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});

  const toggleFile = (fileName: string) => {
    onUserInteract();
    onSelectFile(fileName);
    setExpandedFiles((prev) => {
      const currentlyExpanded = prev[fileName] !== undefined ? prev[fileName] : true;
      return {
        ...prev,
        [fileName]: !currentlyExpanded,
      };
    });
  };

  const toggleAll = (expand: boolean) => {
    onUserInteract();
    const next: Record<string, boolean> = {};
    activeTask.filesList.forEach((f) => {
      next[f.name] = expand;
    });
    setExpandedFiles(next);
  };

  // Get active code string
  const currentFileName = selectedFile || activeTask.filesList[0]?.name || activeTask.fileName || 'apps/web/components/repo-picker.tsx';
  let fileCode = FILE_CONTENTS[currentFileName];

  if (!fileCode) {
    const diffs = activeTask.fileDiffs?.[currentFileName];
    if (diffs && diffs.length > 0) {
      fileCode = diffs
        .filter((d) => d.type !== 'deletion' && d.type !== 'header')
        .map((d) => d.code.replace(/^\+/, ''))
        .join('\n');
    } else {
      fileCode = `// File: ${currentFileName}\n// Reconstructed workspace source code\n\nexport function Module() {\n  return (\n    <div className="p-4 bg-zinc-900 text-white rounded-lg">\n      <p>Source component for ${currentFileName}</p>\n    </div>\n  );\n}`;
    }
  }

  const codeLines = fileCode.split('\n');

  return (
    <div
      className={`w-full max-w-full lg:w-96 lg:max-w-none bg-[#0c0c0ced]/95 lg:bg-black/40 backdrop-blur-xl lg:backdrop-blur-md border-l border-white/5 flex flex-col min-w-0 select-none shrink-0 absolute lg:static inset-y-0 right-0 z-30 transition-transform duration-300 ${
        isRightSidebarOpen ? 'translate-x-0 flex' : 'translate-x-full hidden'
      }`}
    >
      {/* Sticky Panel Header */}
      <div className="border-b border-white/5 h-10 flex items-center shrink-0 bg-zinc-950/80">
        <button
          type="button"
          onClick={() => {
            onUserInteract();
            setIsRightSidebarOpen(false);
          }}
          className="lg:hidden h-full px-3 flex items-center justify-center text-zinc-400 hover:text-white border-r border-white/5 shrink-0 transition-colors"
          title="Close Review Panel"
        >
          <X className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => {
            onUserInteract();
            setActiveTab('review');
          }}
          className={`px-4 h-full flex items-center justify-center text-[11px] font-mono transition-colors border-r border-white/5 ${
            activeTab === 'review' || activeTask.id === 'new-task'
              ? 'border-b-2 border-white text-white font-semibold bg-white/[0.03]'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Review ({activeTask.filesList.length})
        </button>

        {activeTask.id !== 'new-task' && (
          <button
            type="button"
            onClick={() => {
              onUserInteract();
              setActiveTab('code');
            }}
            className={`px-3.5 h-full flex items-center gap-2 justify-center text-[11px] font-mono transition-colors border-r border-white/5 max-w-[200px] truncate ${
              activeTab === 'code'
                ? 'border-b-2 border-white text-white font-semibold bg-white/[0.03]'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
            title={currentFileName}
          >
            <FileCode className={`w-3.5 h-3.5 shrink-0 ${activeTab === 'code' ? 'text-sky-400' : 'text-zinc-500'}`} />
            <span className="truncate">{currentFileName.split('/').pop()}</span>
          </button>
        )}
      </div>

      {activeTab === 'review' ? (
        <>
          {/* Mode Controls Bar */}
          <div className="px-3 py-2 bg-white/[0.01] border-b border-white/5 flex items-center justify-between shrink-0 font-mono text-[10px] text-zinc-500">
            <div className="flex items-center gap-1.5 text-zinc-300 font-medium cursor-pointer hover:text-white transition-colors">
              <span>Git changes</span>
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  onUserInteract();
                  setDiffMode('unified');
                }}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  diffMode === 'unified' ? 'bg-white/10 text-white font-semibold' : 'hover:text-zinc-300'
                }`}
              >
                Unified
              </button>

              <button
                type="button"
                onClick={() => {
                  onUserInteract();
                  setDiffMode('split');
                }}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  diffMode === 'split' ? 'bg-white/10 text-white font-semibold' : 'hover:text-zinc-300'
                }`}
              >
                Split
              </button>
            </div>
          </div>

          {/* Main Diff Content Area */}
          <div
            onScroll={() => onUserInteract()}
            className="flex-1 overflow-y-auto p-2.5 font-mono text-[11px] leading-relaxed no-scrollbar select-text bg-zinc-950/40 space-y-2"
          >
            {activeTask.filesList.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center text-zinc-500 font-mono text-xs">
                <span>No files changed</span>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Quick Actions Header */}
                <div className="flex items-center justify-between px-1 text-[10px] text-zinc-500 uppercase tracking-wider font-mono">
                  <span>{activeTask.filesList.length} files changed</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleAll(true)}
                      className="hover:text-zinc-300 transition-colors normal-case"
                    >
                      Expand all
                    </button>
                    <span>/</span>
                    <button
                      type="button"
                      onClick={() => toggleAll(false)}
                      className="hover:text-zinc-300 transition-colors normal-case"
                    >
                      Collapse all
                    </button>
                  </div>
                </div>

                {/* Accordion File Cards */}
                {activeTask.filesList.map((file, idx) => {
                  const isExpanded =
                    expandedFiles[file.name] !== undefined
                      ? expandedFiles[file.name]
                      : selectedFile
                      ? file.name === selectedFile
                      : idx === 0;
                  const isSelected = selectedFile === file.name;
                  const diffs: DiffLine[] = activeTask.fileDiffs?.[file.name] || [
                    { type: 'header', code: `@@ -1,5 +1,8 @@ ${file.name}` },
                    { type: 'neutral', lineNum: 1, code: `// Updated ${file.name}` },
                    { type: 'deletion', lineNum: 2, code: `-  const ready = false;` },
                    { type: 'addition', lineNum: 2, code: `+  const ready = true;` },
                  ];

                  return (
                    <div
                      key={file.name}
                      className={`rounded-lg border transition-all overflow-hidden ${
                        isSelected
                          ? 'border-white/20 bg-zinc-950/80 shadow-md ring-1 ring-white/10'
                          : 'border-white/10 bg-zinc-950/50 hover:border-white/15'
                      }`}
                    >
                      {/* File Header Bar */}
                      <button
                        type="button"
                        onClick={() => toggleFile(file.name)}
                        className="w-full px-2.5 py-2 flex items-center justify-between text-[11px] font-mono bg-white/[0.02] hover:bg-white/[0.05] transition-colors"
                      >
                        <div className="flex items-center gap-2 truncate pr-2 min-w-0">
                          <ChevronRight
                            className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform duration-200 ${
                              isExpanded ? 'rotate-90 text-white' : ''
                            }`}
                          />
                          <FileCode className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                          <span className="truncate text-zinc-200 font-medium">{file.name}</span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0 font-mono text-[10.5px]">
                          <span className="text-emerald-400 font-semibold">+{file.added}</span>
                          <span className="text-red-400 font-semibold">-{file.removed}</span>
                        </div>
                      </button>

                      {/* Dropdown Diff Content */}
                      {isExpanded && (
                        <div className="border-t border-white/10 bg-black/70 p-2 overflow-x-auto text-[10.5px]">
                          {diffMode === 'unified' ? (
                            <div className="space-y-0.5">
                              {diffs.map((line, idx) => {
                                if (line.type === 'header') {
                                  return (
                                    <div
                                      key={idx}
                                      className="text-zinc-500 bg-white/[0.03] px-2 py-0.5 rounded text-[9.5px] font-mono my-1 border border-white/5"
                                    >
                                      {line.code}
                                    </div>
                                  );
                                }

                                let bgClass = 'hover:bg-white/[0.02] text-zinc-400';
                                if (line.type === 'addition') {
                                  bgClass =
                                    'bg-emerald-500/10 text-emerald-300 px-1.5 py-0.5 rounded-sm border-l-2 border-emerald-400';
                                } else if (line.type === 'deletion') {
                                  bgClass =
                                    'bg-red-500/10 text-red-300 px-1.5 py-0.5 rounded-sm border-l-2 border-red-400 line-through opacity-80';
                                }

                                return (
                                  <div
                                    key={idx}
                                    className={`flex items-start gap-2 font-mono whitespace-pre ${bgClass}`}
                                  >
                                    {line.lineNum !== undefined && (
                                      <span className="w-6 text-right select-none text-zinc-600 text-[9px] shrink-0 pt-0.5">
                                        {line.lineNum}
                                      </span>
                                    )}
                                    <span className="truncate block">{line.code}</span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="space-y-1 text-[10px]">
                              {diffs.map((line, idx) => {
                                if (line.type === 'header') {
                                  return (
                                    <div
                                      key={idx}
                                      className="text-zinc-500 bg-white/[0.03] px-2 py-0.5 rounded text-[9.5px] border border-white/5"
                                    >
                                      {line.code}
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    key={idx}
                                    className="grid grid-cols-2 gap-1.5 border-b border-white/[0.02] py-0.5"
                                  >
                                    <div
                                      className={`p-1 rounded font-mono truncate ${
                                        line.type === 'deletion'
                                          ? 'bg-red-500/15 text-red-300 border-l border-red-400/50'
                                          : 'text-zinc-600'
                                      }`}
                                    >
                                      {line.type === 'deletion' ? line.code : ''}
                                    </div>
                                    <div
                                      className={`p-1 rounded font-mono truncate ${
                                        line.type === 'addition'
                                          ? 'bg-emerald-500/15 text-emerald-300 border-l border-emerald-400/50'
                                          : 'text-zinc-400'
                                      }`}
                                    >
                                      {line.type === 'addition'
                                        ? line.code
                                        : line.type === 'neutral'
                                        ? line.code
                                        : ''}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        /* CODE TAB VIEW */
        <div className="flex-1 flex flex-col min-h-0 bg-[#0d0d0f]">
          {/* Subheader File Path & Stats */}
          <div className="px-3 py-2 bg-[#121215] border-b border-white/5 text-[11px] font-mono text-zinc-400 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 truncate pr-2 min-w-0">
              <FileCode className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span className="truncate font-medium text-zinc-200">{currentFileName}</span>
            </div>
            <span className="text-zinc-500 text-[10px] shrink-0 ml-2">{codeLines.length} lines</span>
          </div>

          {/* Code Viewer with Line Numbers */}
          <div
            onScroll={() => onUserInteract()}
            className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed select-text bg-[#09090b]"
          >
            <div className="min-w-max">
              {codeLines.map((line, idx) => (
                <div key={idx} className="flex hover:bg-white/[0.04] transition-colors group">
                  <span className="w-10 shrink-0 text-right pr-3.5 select-none text-zinc-600 group-hover:text-zinc-400 font-mono text-[11px] leading-relaxed">
                    {idx + 1}
                  </span>
                  <span className="font-mono text-[11px] leading-relaxed whitespace-pre pr-4">
                    {renderSyntaxTokens(line)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
