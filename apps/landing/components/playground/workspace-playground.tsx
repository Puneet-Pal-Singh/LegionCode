'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MOCK_TASKS } from './mock-tasks';
import LeftSidebar from './left-sidebar';
import AgentChatPanel from './agent-chat-panel';
import ReviewPanel from './review-panel';
import { HeroDemoStep, MockTask, ChatMessage } from './types';
import MobileHeroShowcase from '@/components/hero/mobile-hero-showcase';

export default function WorkspacePlayground() {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Tasks state
  const [tasks, setTasks] = useState<Record<string, MockTask>>(MOCK_TASKS);

  // Active task selection
  const [activeTaskId, setActiveTaskId] = useState<string>('onboarding');

  const newTaskMock: MockTask = {
    id: 'new-task',
    title: 'New Task',
    repo: 'LegionCode',
    timeAgo: 'just now',
    duration: '0s',
    userPrompt: '',
    agentAck: '',
    summary: '',
    fileName: 'apps/web/components/repo-picker.tsx',
    changes: { added: 0, removed: 0 },
    filesList: [],
    fileDiffs: {},
    messages: [],
  };

  const activeTask = activeTaskId === 'new-task' ? newTaskMock : (tasks[activeTaskId] || tasks['onboarding']);
  const chatMessages = activeTask.messages || [];

  // Active selected file for diff review
  const [selectedFile, setSelectedFile] = useState<string>('apps/web/components/repo-picker.tsx');
  const [rightSidebarTab, setRightSidebarTab] = useState<'review' | 'code'>('review');

  // Interactive state
  const [inputValue, setInputValue] = useState<string>('');
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>('GPT 5.6 Sol');
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState<boolean>(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState<boolean>(true);

  // Default demo step to 'review' so all content is shown always
  const [demoStep, setDemoStep] = useState<HeroDemoStep>('review');
  const [hasPlayedOnce, setHasPlayedOnce] = useState<boolean>(true);
  const [userInteracted, setUserInteracted] = useState<boolean>(true);
  const timeoutsRef = useRef<NodeJS.Timeout[]>([]);

  // Clear pending timers helper
  const clearSequenceTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  // Signal user interaction: immediately stops autoplay
  const handleUserInteract = useCallback(() => {
    setUserInteracted((prev) => {
      if (!prev) {
        clearSequenceTimeouts();
        setDemoStep((step) => (step !== 'completed' && step !== 'review' ? 'review' : step));
        return true;
      }
      return prev;
    });
  }, [clearSequenceTimeouts]);

  // Switch task handler
  const handleSelectTask = (taskId: string) => {
    handleUserInteract();
    setActiveTaskId(taskId);
    if (taskId === 'new-task') {
      setIsRightSidebarOpen(false);
    } else {
      setIsRightSidebarOpen(true);
      const selectedTask = tasks[taskId] || tasks['onboarding'];
      setSelectedFile(selectedTask.fileName || selectedTask.filesList[0]?.name || 'apps/web/components/repo-picker.tsx');
    }
  };

  // Start the 1-time scripted demo sequence when visible
  const startDemoSequence = useCallback(() => {
    if (hasPlayedOnce || userInteracted) return;

    // Check prefers-reduced-motion
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDemoStep('review');
      setHasPlayedOnce(true);
      return;
    }

    setHasPlayedOnce(true);
    clearSequenceTimeouts();

    const steps: { step: HeroDemoStep; delay: number }[] = [
      { step: 'task-submitted', delay: 200 },
      { step: 'planning', delay: 1400 },
      { step: 'exploring', delay: 3000 },
      { step: 'editing', delay: 5200 },
      { step: 'testing', delay: 7200 },
      { step: 'completed', delay: 8800 },
      { step: 'review', delay: 10200 },
    ];

    steps.forEach(({ step, delay }) => {
      const timer = setTimeout(() => {
        setDemoStep((prev) => {
          if (userInteracted) return prev;
          return step;
        });
      }, delay);
      timeoutsRef.current.push(timer);
    });
  }, [hasPlayedOnce, userInteracted, clearSequenceTimeouts]);

  // IntersectionObserver to trigger demo when scrolled near viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !hasPlayedOnce && !userInteracted) {
            startDemoSequence();
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      clearSequenceTimeouts();
    };
  }, [hasPlayedOnce, userInteracted, startDemoSequence, clearSequenceTimeouts]);

  // Handle visibility change (pause/stop if tab hidden)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleUserInteract();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [handleUserInteract]);

  // Handle starting a new task from New Chat screen
  const handleStartNewTask = (promptText: string) => {
    handleUserInteract();
    if (!promptText.trim()) return;

    const taskId = `task-${Date.now()}`;
    const newTaskObj: MockTask = {
      id: taskId,
      title: promptText.length > 32 ? promptText.slice(0, 32) + '...' : promptText,
      repo: 'LegionCode',
      timeAgo: 'just now',
      duration: '1m 24s',
      userPrompt: promptText,
      agentAck: `I'll update the workspace files to fulfill your request and run the validation gates.`,
      summary: `Updated workspace files based on "${promptText}". All checks pass and the changes are ready for review.`,
      fileName: 'apps/web/components/repo-picker.tsx',
      changes: { added: 24, removed: 6 },
      toolSteps: [
        { type: 'explore', text: '3 files' },
        { type: 'read', text: 'apps/web/app/onboarding/page.tsx' },
        { type: 'search', text: promptText.slice(0, 30) },
        { type: 'edit', text: 'apps/web/app/onboarding/page.tsx', added: 42, removed: 8 },
        { type: 'edit', text: 'apps/web/components/repo-picker.tsx', added: 24, removed: 6 },
        { type: 'edit', text: 'apps/web/lib/github.ts', added: 12, removed: 2 },
        { type: 'run', text: 'pnpm vitest run onboarding', status: '24 passed' },
      ],
      filesList: [
        { name: 'apps/web/app/onboarding/page.tsx', added: 42, removed: 8 },
        { name: 'apps/web/components/repo-picker.tsx', added: 24, removed: 6 },
        { name: 'apps/web/lib/github.ts', added: 12, removed: 2 },
      ],
      fileDiffs: MOCK_TASKS['onboarding'].fileDiffs,
      messages: [
        { sender: 'user', text: promptText },
        {
          sender: 'agent',
          text: `I've initialized a new task for "${promptText}". Setting up workspace context and scanning repository dependencies.`,
        },
      ],
    };

    setTasks((prev) => ({
      [taskId]: newTaskObj,
      ...prev,
    }));
    setActiveTaskId(taskId);
    setIsRightSidebarOpen(true);
    setSelectedFile('apps/web/components/repo-picker.tsx');
    setInputValue('');
    setIsThinking(true);

    setTimeout(() => {
      setIsThinking(false);
    }, 1000);
  };

  // Handle typing inside composer
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    handleUserInteract();
    if (!inputValue.trim() || isThinking) return;

    if (activeTaskId === 'new-task') {
      handleStartNewTask(inputValue);
      return;
    }

    const userText = inputValue;
    setInputValue('');

    // Append user message to active task's messages
    setTasks((prev) => {
      const task = prev[activeTaskId];
      if (!task) return prev;
      return {
        ...prev,
        [activeTaskId]: {
          ...task,
          messages: [...(task.messages || []), { sender: 'user' as const, text: userText }],
        },
      };
    });

    setIsThinking(true);

    setTimeout(() => {
      const lower = userText.toLowerCase();
      let agentMsg: ChatMessage;

      if (lower.includes('hello') || lower.includes('hi')) {
        agentMsg = {
          sender: 'agent',
          text: 'To try LegionCode Agent, ',
          link: { label: 'download LegionCode.', url: 'https://ai.studio' },
        };
      } else if (lower.includes('cool') || lower.includes('ok') || lower.includes('yoyo') || lower.includes('thanks')) {
        agentMsg = {
          sender: 'agent',
          text: 'To try the LegionCode app, ',
          link: { label: 'download here.', url: 'https://ai.studio' },
        };
      } else if (lower.includes('test') || lower.includes('vitest')) {
        agentMsg = {
          sender: 'agent',
          text: 'Running pnpm vitest run onboarding... All 24 assertions passed!',
        };
      } else {
        agentMsg = {
          sender: 'agent',
          text: 'To try LegionCode Agent, ',
          link: { label: 'download LegionCode.', url: 'https://ai.studio' },
        };
      }

      setTasks((prev) => {
        const task = prev[activeTaskId];
        if (!task) return prev;
        return {
          ...prev,
          [activeTaskId]: {
            ...task,
            messages: [...(task.messages || []), agentMsg],
          },
        };
      });
      setIsThinking(false);
    }, 1000);
  };

  const handleRestartDemo = () => {
    setUserInteracted(false);
    setHasPlayedOnce(false);
    setActiveTaskId('onboarding');
    setSelectedFile('apps/web/components/repo-picker.tsx');
    setDemoStep('idle');
    setTimeout(() => {
      startDemoSequence();
    }, 100);
  };

  return (
    <div id="workspace" ref={containerRef} className="relative mx-auto mb-14 w-full max-w-7xl px-2 sm:mb-16 sm:px-4 lg:px-6">
      {/* Mobile-Only Static Hero Showcase (Matches Screenshot) */}
      <div className="block md:hidden">
        <MobileHeroShowcase />
      </div>

      {/* Desktop-Only Standalone Interactive Workspace */}
      <div className="hidden md:block relative">
        {/* Ambient background glow behind individual app window */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[450px] bg-white/[0.025] rounded-full blur-[140px] pointer-events-none" />

        {/* Standalone Application Window */}
        <div className="relative z-10 bg-[#0c0c0c] border border-white/15 rounded-xl lg:rounded-2xl overflow-hidden shadow-[0_30px_90px_-20px_rgba(0,0,0,0.95)] flex flex-col h-[650px] md:h-[700px] text-zinc-300 font-sans text-xs">
          {/* Header Bar */}
          <div className="bg-white/[0.04] backdrop-blur-md border-b border-white/5 px-4 py-2.5 grid grid-cols-3 items-center select-none">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-zinc-700 hover:bg-red-500/80 transition-colors" />
              <div className="w-2.5 h-2.5 rounded-full bg-zinc-700 hover:bg-yellow-500/80 transition-colors" />
              <div className="w-2.5 h-2.5 rounded-full bg-zinc-700 hover:bg-emerald-500/80 transition-colors" />
            </div>

            <div className="text-center">
              <span className="text-zinc-400 font-mono text-[11px] select-none font-medium">
                LegionCode Desktop
              </span>
            </div>

            <div className="flex items-center justify-end font-mono text-[10px] text-zinc-500">
              <div className="hidden sm:flex items-center text-zinc-400">
                <span>main</span>
              </div>
            </div>
          </div>

          {/* 3-Panel Workspace Body */}
          <div className="flex-1 flex overflow-hidden min-w-0 relative">
            {/* Left Sidebar */}
            <LeftSidebar
              activeTaskId={activeTaskId}
              onSelectTask={handleSelectTask}
              isLeftSidebarOpen={isLeftSidebarOpen}
              setIsLeftSidebarOpen={setIsLeftSidebarOpen}
              tasks={tasks}
            />

            {/* Center Agent Chat Thread Panel */}
            <AgentChatPanel
              activeTask={activeTask}
              demoStep={demoStep}
              isLeftSidebarOpen={isLeftSidebarOpen}
              setIsLeftSidebarOpen={setIsLeftSidebarOpen}
              isRightSidebarOpen={isRightSidebarOpen}
              setIsRightSidebarOpen={setIsRightSidebarOpen}
              rightSidebarTab={rightSidebarTab}
              setRightSidebarTab={setRightSidebarTab}
              chatMessages={chatMessages}
              inputValue={inputValue}
              setInputValue={setInputValue}
              isThinking={isThinking}
              onSendMessage={handleSendMessage}
              onStartNewTask={handleStartNewTask}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              selectedFile={selectedFile}
              onSelectFile={(fileName) => {
                handleUserInteract();
                setSelectedFile(fileName);
              }}
              onUserInteract={handleUserInteract}
            />

            {/* Right Review Code Diff Panel */}
            <ReviewPanel
              activeTask={activeTask}
              selectedFile={selectedFile}
              onSelectFile={(fileName) => {
                handleUserInteract();
                setSelectedFile(fileName);
              }}
              isRightSidebarOpen={isRightSidebarOpen}
              setIsRightSidebarOpen={setIsRightSidebarOpen}
              activeTab={rightSidebarTab}
              setActiveTab={setRightSidebarTab}
              onUserInteract={handleUserInteract}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
