"use client";

import { ChevronRight, X } from "lucide-react";
import type { DiffLine, MockTask } from "./types";

interface ReviewPanelProps {
  activeTask: MockTask;
  expandedFiles: Record<string, boolean>;
  isOpen: boolean;
  onClose: () => void;
  onToggleFile: (fileName: string) => void;
}

interface ReviewFile {
  added: number;
  diffLines: DiffLine[];
  name: string;
  removed: number;
}

function buildMockDiff(file: {
  added: number;
  name: string;
  removed: number;
}): DiffLine[] {
  const fileName = file.name.split("/").pop() ?? file.name;
  return [
    {
      type: "neutral",
      lineNum: 1,
      code: `// Compiled and synchronized: ${file.name}`,
    },
    {
      type: "addition",
      lineNum: 2,
      code: `+ // Successfully validated boundaries for ${fileName}`,
    },
    {
      type: "addition",
      lineNum: 3,
      code: `+ const totalLinesAdded = ${file.added};`,
    },
    {
      type: "deletion",
      lineNum: 4,
      code: `- const legacyDelta = ${file.removed};`,
    },
    { type: "neutral", lineNum: 5, code: '  return { status: "ready" };' },
  ];
}

function ReviewTabs({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-white/5">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close review panel"
        className="flex h-full shrink-0 items-center justify-center border-r border-white/5 px-3 text-zinc-400 transition-colors hover:bg-white/5 hover:text-white lg:hidden"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="flex-1 border-b border-white py-3 text-center text-[10.5px] font-medium tracking-tight text-white">
        REVIEW (3)
      </div>
      <div className="flex-1 py-3 text-center text-[10.5px] text-zinc-500">
        FILE CHANGES (3)
      </div>
      <div className="flex-1 py-3 text-center text-[10.5px] text-zinc-400">
        FILES
      </div>
    </div>
  );
}

function ReviewToolbar() {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-white/5 bg-white/[0.01] px-3 py-2 font-mono text-[9.5px] text-zinc-500">
      <div className="flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5">
        <span>Git Status</span>
        <ChevronRight className="h-2.5 w-2.5 rotate-90" />
      </div>
      <div className="flex items-center gap-2">
        <span>Unified</span>
        <span className="opacity-40">/</span>
        <span className="font-bold text-white">Split</span>
      </div>
    </div>
  );
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="space-y-0.5 font-mono">
      {lines.map((line) => {
        const addition = line.type === "addition";
        const deletion = line.type === "deletion";
        return (
          <div
            key={`${line.lineNum}-${line.code}`}
            className={`flex items-start gap-2.5 truncate ${addition ? "border-l border-white/65 bg-white/10 py-0.5 pl-1" : ""} ${deletion ? "bg-black/30 py-0.5 pl-1 opacity-30" : ""}`}
          >
            <span className="w-6 shrink-0 select-none pt-0.5 text-right text-[9px] text-zinc-700">
              {line.lineNum}
            </span>
            <span
              className={`block truncate whitespace-pre text-[10px] ${addition ? "font-medium text-white" : deletion ? "line-through text-zinc-650" : "text-zinc-500"}`}
            >
              {line.code}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FileAccordion({
  expanded,
  file,
  onToggle,
}: {
  expanded: boolean;
  file: ReviewFile;
  onToggle: (fileName: string) => void;
}) {
  return (
    <div
      className={`mt-3 rounded border border-white/10 bg-white/5 p-2 transition-all ${expanded ? "border-white/20 opacity-100" : "opacity-50 hover:opacity-85"}`}
    >
      <button
        type="button"
        onClick={() => onToggle(file.name)}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[1fr_auto] items-center gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] text-zinc-350">
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          {file.name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-right font-mono text-[10px] font-semibold">
          <span className="text-emerald-500">+{file.added}</span>
          <span className="text-rose-500">-{file.removed}</span>
        </span>
      </button>
      {expanded && (
        <div className="mt-2 border-t border-white/5 pt-2">
          <DiffLines lines={file.diffLines} />
        </div>
      )}
    </div>
  );
}

function buildReviewFiles(task: MockTask): ReviewFile[] {
  const primary = {
    name: task.fileName,
    added: task.changes.added,
    removed: task.changes.removed,
    diffLines: task.diffLines,
  };
  const others = (task.filesList ?? [])
    .filter((file) => file.name !== task.fileName)
    .map((file) => ({ ...file, diffLines: buildMockDiff(file) }));
  return [primary, ...others];
}

export default function ReviewPanel({
  activeTask,
  expandedFiles,
  isOpen,
  onClose,
  onToggleFile,
}: ReviewPanelProps) {
  const files = buildReviewFiles(activeTask);
  return (
    <div
      className={`absolute inset-y-0 right-0 z-30 flex w-full max-w-full shrink-0 flex-col border-l border-white/5 bg-[#0c0c0ced]/95 backdrop-blur-xl transition-transform duration-300 lg:static lg:flex lg:w-80 lg:max-w-none lg:translate-x-0 lg:bg-black/25 lg:backdrop-blur-md ${isOpen ? "translate-x-0" : "translate-x-full"}`}
    >
      <ReviewTabs onClose={onClose} />
      <ReviewToolbar />
      <div className="no-scrollbar flex-1 overflow-y-auto bg-transparent p-2 font-mono text-[10.5px] leading-relaxed">
        {files.map((file) => (
          <FileAccordion
            key={file.name}
            expanded={
              expandedFiles[file.name] ?? file.name === activeTask.fileName
            }
            file={file}
            onToggle={onToggleFile}
          />
        ))}
      </div>
    </div>
  );
}
