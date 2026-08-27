'use client';

import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronRight,
  ChevronDown,
  CornerDownLeft,
  PanelLeft,
  PanelRight,
  Check,
  FileText,
  Search,
  Code,
  Play,
  ArrowUpRight,
  Maximize2,
  Cloud,
  Plus,
  ArrowUp,
  MoreHorizontal,
  Code2,
  ShieldCheck,
  Stethoscope,
} from 'lucide-react';
import { MockTask, HeroDemoStep, ChatMessage, ToolStep } from './types';

interface AgentChatPanelProps {
  activeTask: MockTask;
  demoStep: HeroDemoStep;
  isLeftSidebarOpen: boolean;
  setIsLeftSidebarOpen: (open: boolean) => void;
  isRightSidebarOpen: boolean;
  setIsRightSidebarOpen: (open: boolean) => void;
  rightSidebarTab?: 'review' | 'code';
  setRightSidebarTab?: (tab: 'review' | 'code') => void;
  chatMessages: ChatMessage[];
  inputValue: string;
  setInputValue: (val: string) => void;
  isThinking: boolean;
  onSendMessage: (e: React.FormEvent) => void;
  onStartNewTask: (promptText: string) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  selectedFile: string;
  onSelectFile: (fileName: string) => void;
  onUserInteract: () => void;
}

export default function AgentChatPanel({
  activeTask,
  demoStep,
  isLeftSidebarOpen,
  setIsLeftSidebarOpen,
  isRightSidebarOpen,
  setIsRightSidebarOpen,
  rightSidebarTab,
  setRightSidebarTab,
  chatMessages,
  inputValue,
  setInputValue,
  isThinking,
  onSendMessage,
  onStartNewTask,
  selectedModel,
  setSelectedModel,
  selectedFile,
  onSelectFile,
  onUserInteract,
}: AgentChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = React.useState(false);

  // Helper step visibility checks
  const isTaskSubmitted = demoStep !== 'idle';
  const isPlanning = isTaskSubmitted && demoStep !== 'task-submitted';
  const isExploring = isPlanning && demoStep !== 'planning';
  const isEditing = isExploring && demoStep !== 'exploring';
  const isTesting = isEditing && demoStep !== 'editing';
  const isCompleted = isTesting && demoStep !== 'testing';

  const currentToolSteps = React.useMemo(() => {
    if (activeTask.toolSteps && activeTask.toolSteps.length > 0) {
      return activeTask.toolSteps;
    }
    const steps: ToolStep[] = [
      { type: 'explore', text: `${activeTask.filesList?.length || 1} files` },
      { type: 'read', text: activeTask.fileName || activeTask.filesList?.[0]?.name || 'src/index.ts' },
      { type: 'search', text: activeTask.title },
    ];
    (activeTask.filesList || []).forEach((file) => {
      steps.push({
        type: 'edit',
        text: file.name,
        added: file.added,
        removed: file.removed,
      });
    });
    steps.push({
      type: 'run',
      text: `pnpm test`,
      status: 'passed',
    });
    return steps;
  }, [activeTask]);

  const exploreToolSteps = currentToolSteps.filter((s) => s.type === 'explore' || s.type === 'read' || s.type === 'search');
  const editToolSteps = currentToolSteps.filter((s) => s.type === 'edit');
  const runToolSteps = currentToolSteps.filter((s) => s.type === 'run');

  // Auto-scroll center thread as new content arrives during demo, unless user interacted
  useEffect(() => {
    if (scrollRef.current && (demoStep !== 'idle' && demoStep !== 'completed' && demoStep !== 'review')) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [demoStep, chatMessages]);

  const handleScroll = () => {
    // If user manually scrolls during sequence, signal interaction to stop autoplay
    if (demoStep !== 'completed' && demoStep !== 'review' && demoStep !== 'idle') {
      onUserInteract();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-zinc-950/60 backdrop-blur-lg relative">
      {/* Top Bar with active ticket title & responsive controls */}
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between shrink-0 select-none gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => {
              onUserInteract();
              setIsLeftSidebarOpen(!isLeftSidebarOpen);
            }}
            className="p-1 text-zinc-400 hover:text-white transition-colors shrink-0 flex items-center justify-center cursor-pointer"
            title="Toggle Projects"
          >
            <PanelLeft className="w-3.5 h-3.5" />
          </button>

          <span className="font-semibold text-white truncate max-w-[150px] sm:max-w-[280px] text-xs">
            {activeTask.title}
          </span>

          {activeTask.id === 'new-task' && (
            <button
              type="button"
              className="text-zinc-500 hover:text-white transition-colors cursor-pointer p-0.5"
              title="More options"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {activeTask.id === 'new-task' ? (
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                className="bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 px-2 py-1 rounded-md text-[10.5px] font-mono flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Code2 className="w-3.5 h-3.5 text-zinc-400" />
                <span>Open</span>
                <ChevronDown className="w-3 h-3 text-zinc-500" />
              </button>
              <button
                type="button"
                className="p-1 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                title="Details"
              >
                <FileText className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  onUserInteract();
                  setIsRightSidebarOpen(!isRightSidebarOpen);
                }}
                className="p-1 text-zinc-400 hover:text-white transition-colors shrink-0 flex items-center justify-center cursor-pointer"
                title="Toggle Review Diff"
              >
                <PanelRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                onUserInteract();
                setIsRightSidebarOpen(!isRightSidebarOpen);
              }}
              className="p-1 text-zinc-400 hover:text-white transition-colors shrink-0 flex items-center justify-center cursor-pointer"
              title="Toggle Review Diff"
            >
              <PanelRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Mobile overlay for drawers */}
      {(isLeftSidebarOpen || isRightSidebarOpen) && (
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-[2px] z-20 lg:hidden cursor-pointer"
          onClick={() => {
            setIsLeftSidebarOpen(false);
            setIsRightSidebarOpen(false);
          }}
        />
      )}

      {activeTask.id === 'new-task' ? (
        /* New Task / New Chat UI */
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 text-center select-none overflow-y-auto relative">
          {/* Cloud Badge Icon */}
          <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center text-zinc-200 mb-3 shadow-2xl backdrop-blur-md">
            <Cloud className="w-6 h-6 stroke-[1.5]" />
          </div>

          {/* Heading */}
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white font-sans">
            Let&apos;s build
          </h1>

          {/* Dropdown project title */}
          <button
            type="button"
            className="mt-1 flex items-center gap-1 text-xs font-mono text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <span>LegionCode</span>
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          </button>

          {/* Central Prompt Card */}
          <div className="mt-8 w-full max-w-xl bg-[#0c0c0e] border border-white/10 rounded-2xl p-3.5 shadow-2xl text-left relative transition-all focus-within:border-white/25">
            <textarea
              rows={3}
              className="w-full bg-transparent border-0 outline-none text-white placeholder-zinc-500 text-xs font-sans resize-none p-1"
              placeholder="Ask LegionCode anything, @ to add files, / for commands..."
              value={inputValue}
              onChange={(e) => {
                onUserInteract();
                setInputValue(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  // Sending is disabled from the new chat window
                }
              }}
            />

            <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between text-xs select-none gap-2 flex-wrap sm:flex-nowrap">
              {/* Left Controls */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  className="w-6 h-6 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
                  title="Add files"
                >
                  <Plus className="w-4 h-4" />
                </button>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsModelMenuOpen(!isModelMenuOpen)}
                    className="bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded border border-white/10 text-zinc-300 text-[10.5px] font-mono flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <span>{selectedModel}</span>
                    <ChevronDown className="w-3 h-3 text-zinc-500" />
                  </button>

                  {isModelMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1 w-40 bg-zinc-900 border border-white/10 rounded-lg shadow-xl py-1 z-30 font-mono text-[10px]">
                      {[
                        'GPT 5.6 Sol',
                        'GPT 5.6 Luna',
                        'Gemini 3.6 Flash',
                        'Claude Fable 5',
                        'Claude Opus 5',
                        'Kimi K3',
                      ].map((model) => (
                        <button
                          key={model}
                          type="button"
                          onClick={() => {
                            setSelectedModel(model);
                            setIsModelMenuOpen(false);
                          }}
                          className={`w-full text-left px-2.5 py-1.5 hover:bg-white/10 transition-colors ${
                            selectedModel === model ? 'text-white font-bold bg-white/5' : 'text-zinc-400'
                          }`}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="text-[10.5px] font-mono text-zinc-400 hover:text-zinc-200 px-1.5 py-0.5 flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Stethoscope className="w-3 h-3 text-zinc-500" />
                  <span>dev</span>
                  <ChevronDown className="w-2.5 h-2.5 text-zinc-600" />
                </button>

                <button
                  type="button"
                  className="text-[10.5px] font-mono text-zinc-400 hover:text-zinc-200 px-1.5 py-0.5 flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <ShieldCheck className="w-3 h-3 text-zinc-500" />
                  <span>Auto edits</span>
                  <ChevronDown className="w-2.5 h-2.5 text-zinc-600" />
                </button>
              </div>

              {/* Submit Button */}
              <button
                type="button"
                onClick={() => {
                  // Do nothing when clicked in new chat window
                }}
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                  inputValue.trim()
                    ? 'bg-white text-black hover:bg-zinc-200 cursor-pointer shadow-md scale-105'
                    : 'bg-white/10 text-zinc-600 cursor-not-allowed'
                }`}
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Standard Chat Thread */
        <>
          {/* Scrollable Thread Content Area */}
      <div
        ref={scrollRef}
        onWheel={handleScroll}
        onTouchMove={handleScroll}
        className="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-xs no-scrollbar"
      >
        {/* 1. User Prompt Bubble */}
        <AnimatePresence>
          {isTaskSubmitted && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="flex justify-end"
            >
              <div className="max-w-[90%] sm:max-w-[85%] bg-zinc-800/80 border border-white/10 rounded-2xl rounded-tr-xs p-3 text-[11.5px] text-zinc-100 leading-relaxed shadow-sm font-sans">
                {activeTask.userPrompt}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 2. Agent Acknowledgement Plan */}
        <AnimatePresence>
          {isPlanning && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-2"
            >
              {/* Worked duration indicator */}
              <div className="flex items-center gap-1.5 text-zinc-500 text-[11px] select-none">
                <span>Worked for <span className="text-zinc-200 font-mono">{activeTask.duration}</span></span>
                <ChevronDown className="w-3 h-3 text-zinc-700" />
              </div>

              <p className="text-[11.5px] text-zinc-300 leading-relaxed font-sans max-w-[90%]">
                {activeTask.agentAck}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 3. Progress Activity Rows */}
        <AnimatePresence>
          {isExploring && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              transition={{ duration: 0.4 }}
              className="space-y-1.5 font-mono text-[11px]"
            >
              {exploreToolSteps.map((step, idx) => (
                <motion.div
                  key={`explore-${idx}`}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 * (idx + 1) }}
                  className="flex items-center gap-2 text-zinc-400 py-0.5 truncate"
                >
                  <span className="text-zinc-500 w-16 shrink-0 font-mono">
                    {step.type === 'explore' ? 'explored' : step.type === 'search' ? 'search' : step.type}
                  </span>
                  <span className="text-zinc-300 truncate font-mono">
                    {step.text.replace(/^(Explored|Searched|Read)\s+/i, '')}
                  </span>
                </motion.div>
              ))}

              {isEditing && (
                <>
                  {editToolSteps.map((step, idx) => (
                    <motion.div
                      key={`edit-${idx}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.15 * idx }}
                      className="flex items-center gap-2 text-zinc-400 py-0.5 truncate"
                    >
                      <span className="text-zinc-500 w-16 shrink-0 font-mono">edited</span>
                      <span className="text-zinc-200 truncate font-mono">
                        {step.text.replace(/^(Explored|Searched|Read)\s+/i, '')}
                      </span>
                      {(step.added !== undefined || step.removed !== undefined) && (
                        <span className="text-[10px] font-mono space-x-1 shrink-0 ml-1.5">
                          {step.added !== undefined && <span className="text-emerald-400">+{step.added}</span>}
                          {step.removed !== undefined && <span className="text-red-400">-{step.removed}</span>}
                        </span>
                      )}
                    </motion.div>
                  ))}
                </>
              )}

              {isTesting && (
                <>
                  {runToolSteps.map((step, idx) => (
                    <motion.div
                      key={`run-${idx}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.15 * idx }}
                      className="flex items-center gap-2 text-zinc-400 py-0.5 truncate"
                    >
                      <span className="text-zinc-500 w-16 shrink-0 font-mono">ran</span>
                      <span className="text-zinc-200 truncate font-mono">
                        {step.text.replace(/^(Explored|Searched|Read)\s+/i, '')}
                      </span>
                      {step.status && (
                        <span className="text-emerald-400 text-[10px] shrink-0 font-mono ml-1.5">{step.status}</span>
                      )}
                    </motion.div>
                  ))}
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* 4. Completion Summary & 5. Changed-Files Block */}
        <AnimatePresence>
          {isCompleted && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="space-y-3"
            >
              <p className="text-zinc-300 text-[11.5px] leading-relaxed font-sans max-w-[90%]">
                {activeTask.summary}
              </p>

              {/* Changed files review card */}
              {(() => {
                const totalAdded = activeTask.filesList.reduce((acc, f) => acc + f.added, 0);
                const totalRemoved = activeTask.filesList.reduce((acc, f) => acc + f.removed, 0);

                const renderFormattedPath = (path: string) => {
                  const lastSlashIndex = path.lastIndexOf('/');
                  if (lastSlashIndex === -1) {
                    return <span className="text-white font-semibold font-mono">{path}</span>;
                  }
                  const dir = path.slice(0, lastSlashIndex + 1);
                  const fileName = path.slice(lastSlashIndex + 1);
                  return (
                    <span className="truncate font-mono">
                      <span className="text-zinc-500">{dir}</span>
                      <span className="text-white font-semibold">{fileName}</span>
                    </span>
                  );
                };

                return (
                  <div className="bg-[#0c0c0e] border border-white/10 rounded-xl overflow-hidden shadow-xl">
                    {/* Header */}
                    <div className="flex items-center justify-between px-3 py-2.5">
                      <div className="flex items-center gap-2 font-mono text-[11px]">
                        <span className="font-semibold text-white">
                          {activeTask.filesList.length} files changed
                        </span>
                        <span className="text-emerald-400 font-medium font-mono text-[10.5px]">+{totalAdded}</span>
                        <span className="text-rose-400 font-medium font-mono text-[10.5px]">-{totalRemoved}</span>
                      </div>
                      <div className="flex items-center gap-2.5 text-zinc-500 text-[10.5px] font-mono">
                        <button
                          type="button"
                          onClick={() => {
                            onUserInteract();
                            if (setRightSidebarTab) setRightSidebarTab('review');
                            setIsRightSidebarOpen(true);
                          }}
                          className="flex items-center gap-1 hover:text-zinc-300 transition-colors cursor-pointer"
                        >
                          <span>Review</span>
                          <ArrowUpRight className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onUserInteract();
                            if (setRightSidebarTab) setRightSidebarTab('review');
                            setIsRightSidebarOpen(true);
                          }}
                          className="hover:text-zinc-300 transition-colors cursor-pointer"
                        >
                          <Maximize2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {/* File List Box - Full width left/right/bottom */}
                    <div className="border-t border-white/10 divide-y divide-white/10 bg-black/40">
                      {activeTask.filesList.map((file) => (
                        <div
                          key={file.name}
                          onClick={() => {
                            onUserInteract();
                            onSelectFile(file.name);
                            if (setRightSidebarTab) setRightSidebarTab('review');
                            setIsRightSidebarOpen(true);
                          }}
                          className={`flex items-center justify-between px-3 py-2 transition-colors cursor-pointer text-[10.5px] font-mono ${
                            selectedFile === file.name
                              ? 'bg-white/10 text-white'
                              : 'hover:bg-white/[0.04] text-zinc-300'
                          }`}
                        >
                          <div className="truncate pr-2">{renderFormattedPath(file.name)}</div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-emerald-400 font-medium">+{file.added}</span>
                            <span className="text-rose-400 font-medium">-{file.removed}</span>
                            <ChevronRight className="w-3 h-3 text-zinc-600" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Custom interactive chat messages */}
        <AnimatePresence initial={false}>
          {chatMessages.map((msg, index) => (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              key={index}
              className={`flex leading-relaxed ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`text-[11.5px] font-sans ${
                  msg.sender === 'user'
                    ? 'p-3 rounded-xl max-w-[85%] bg-zinc-800 text-white border border-white/15'
                    : 'text-zinc-300 max-w-[90%] leading-relaxed'
                }`}
              >
                <span>{msg.text}</span>
                {msg.link && (
                  <a
                    href={msg.link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-orange-400 hover:text-orange-300 font-medium underline underline-offset-2 transition-colors cursor-pointer"
                  >
                    {msg.link.label}
                  </a>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Thinking indicator */}
        {isThinking && (
          <div className="flex items-center gap-2 text-zinc-400 italic text-[11px] font-sans">
            <span className="w-2 h-2 rounded-full bg-white animate-ping" />
            <span>Agent processing...</span>
          </div>
        )}
      </div>

      {/* Fixed Composer at bottom */}
      <form
        onSubmit={(e) => {
          onUserInteract();
          onSendMessage(e);
        }}
        className="p-3 border-t border-white/5 shrink-0 bg-[#0d0d0d]/40 backdrop-blur-md"
      >
        <div className="flex flex-col border border-white/10 rounded-xl bg-white/[0.02] backdrop-blur-md focus-within:border-white/20 transition-all shadow-inner relative">
          <input
            type="text"
            className="bg-transparent border-0 px-3 py-2.5 text-[11.5px] outline-none text-white placeholder-zinc-500 w-full font-sans"
            placeholder="Ask LegionCode anything, @ to add files, / for commands..."
            value={inputValue}
            onChange={(e) => {
              onUserInteract();
              setInputValue(e.target.value);
            }}
            onFocus={() => onUserInteract()}
          />

          <div className="px-2.5 pb-2 pt-1 flex items-center justify-between select-none">
            {/* Model Selector Pill */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  onUserInteract();
                  setIsModelMenuOpen(!isModelMenuOpen);
                }}
                className="bg-white/[0.04] hover:bg-white/[0.08] px-2.5 py-1 rounded-md border border-white/10 text-zinc-200 transition-colors text-[11px] flex items-center gap-2 font-mono cursor-pointer"
              >
                <span className="text-white font-medium">{selectedModel}</span>
                <span className="text-zinc-500 font-normal">High</span>
                <ChevronDown className="w-3 h-3 text-zinc-400 stroke-[1.5]" />
              </button>

              {isModelMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-40 bg-zinc-900 border border-white/10 rounded-lg shadow-xl py-1 z-30 font-mono text-[10px]">
                  {[
                    'GPT 5.6 Sol',
                    'GPT 5.6 Luna',
                    'Gemini 3.6 Flash',
                    'Claude Fable 5',
                    'Claude Opus 5',
                    'Kimi K3',
                  ].map((model) => (
                    <button
                      key={model}
                      type="button"
                      onClick={() => {
                        setSelectedModel(model);
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 hover:bg-white/10 transition-colors ${
                        selectedModel === model ? 'text-white font-bold bg-white/5' : 'text-zinc-400'
                      }`}
                    >
                      {model}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="submit"
              className="w-6 h-6 bg-white hover:bg-zinc-200 text-black flex items-center justify-center rounded-md cursor-pointer transition-colors shadow-md"
            >
              <CornerDownLeft className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </form>
    </>
  )}
</div>
  );
}
