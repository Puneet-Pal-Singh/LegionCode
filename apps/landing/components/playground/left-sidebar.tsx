'use client';

import React from 'react';
import { Settings, ChevronRight, Clock, FolderPlus, SquarePen, Plus } from 'lucide-react';

import { MockTask } from './types';

interface LeftSidebarProps {
  activeTaskId: string;
  onSelectTask: (taskId: string) => void;
  isLeftSidebarOpen: boolean;
  setIsLeftSidebarOpen: (open: boolean) => void;
  tasks?: Record<string, MockTask>;
}

export default function LeftSidebar({
  activeTaskId,
  onSelectTask,
  isLeftSidebarOpen,
  setIsLeftSidebarOpen,
  tasks = {},
}: LeftSidebarProps) {
  const taskList = Object.values(tasks);
  const legionTasks = taskList.filter((t) => t.repo === 'LegionCode' || !t.repo);
  const alphaTasks = taskList.filter((t) => t.repo === 'project-alpha');
  return (
    <div
      className={`w-56 bg-[#0c0c0ced]/95 lg:bg-black/40 backdrop-blur-xl lg:backdrop-blur-md border-r border-white/5 flex flex-col justify-between select-none shrink-0 absolute lg:static inset-y-0 left-0 z-30 transition-all duration-300 ${
        isLeftSidebarOpen ? 'translate-x-0 flex' : '-translate-x-full hidden'
      }`}
    >
      <div className="py-2 space-y-2">
        {/* New Chat Button (Above Workspaces) */}
        <div className="px-1.5">
          <button
            type="button"
            onClick={() => {
              onSelectTask('new-task');
            }}
            className={`w-full px-2.5 py-1.5 rounded-md flex items-center gap-2 transition-all text-xs cursor-pointer ${
              activeTaskId === 'new-task'
                ? 'bg-white/10 text-white font-medium'
                : 'text-zinc-400 hover:bg-white/[0.05] hover:text-white'
            }`}
          >
            <SquarePen className="w-3.5 h-3.5 text-zinc-400" />
            <span className="font-medium text-xs">New chat</span>
          </button>
        </div>

        {/* Scope Selector block */}
        <div className="px-3.5 pt-1.5 flex items-center justify-between text-zinc-500 uppercase tracking-wider font-semibold text-[10px]">
          <span>Projects</span>
          <Settings className="w-3.5 h-3.5 opacity-60 hover:opacity-100 transition-opacity cursor-pointer" />
        </div>

        {/* Workspaces & Tasks List */}
        <div className="px-1.5 space-y-3">
          {/* LegionCode Workspace */}
          <div>
            <div className="px-2 py-1 text-[11px] text-zinc-400 flex items-center justify-between font-mono select-none">
              <div className="flex items-center gap-1">
                <ChevronRight className="w-3.5 h-3.5 rotate-90 text-zinc-500" />
                <span className="font-semibold text-zinc-300">LegionCode/</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onSelectTask('new-task');
                }}
                className="hover:text-white text-zinc-500 transition-colors cursor-pointer"
                title="New Task"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="mt-1 space-y-0.5">
              {activeTaskId === 'new-task' && (
                <button
                  type="button"
                  onClick={() => {
                    onSelectTask('new-task');
                  }}
                  className="w-full px-3 py-1.5 text-left rounded-md flex items-center justify-between gap-1 transition-all bg-white/10 text-white cursor-pointer"
                >
                  <div className="flex items-center gap-1.5 truncate text-xs font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <span className="truncate">New Task</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0">just now</span>
                </button>
              )}

              {legionTasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onSelectTask(t.id);
                  }}
                  className={`w-full px-3 py-1.5 text-left rounded-md flex flex-col gap-0.5 transition-all cursor-pointer ${
                    activeTaskId === t.id
                      ? 'bg-white/10 text-white font-medium'
                      : 'hover:bg-white/[0.04] text-zinc-400'
                  }`}
                >
                  <span className="font-medium truncate text-xs">{t.title}</span>
                  <span className="text-[10px] text-zinc-500 flex items-center gap-1 font-mono">
                    <Clock className="w-2.5 h-2.5 text-zinc-600" /> {t.timeAgo}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* project-alpha Workspace */}
          <div>
            <div className="px-2 py-1 text-[11px] text-zinc-400 flex items-center gap-1 font-mono select-none">
              <ChevronRight className="w-3.5 h-3.5 rotate-90 text-zinc-500" />
              <span className="font-semibold text-zinc-300">project-alpha/</span>
            </div>

            <div className="mt-1 space-y-0.5">
              <button
                type="button"
                onClick={() => {
                  onSelectTask('readme');
                }}
                className={`w-full px-3 py-1.5 text-left rounded-md flex flex-col gap-0.5 transition-all ${
                  activeTaskId === 'readme'
                    ? 'bg-white/10 text-white font-medium'
                    : 'hover:bg-white/[0.04] text-zinc-400'
                }`}
              >
                <span className="font-medium truncate text-xs">Sync README.md docs</span>
                <span className="text-[10px] text-zinc-500 flex items-center gap-1 font-mono">
                  <Clock className="w-2.5 h-2.5 text-zinc-600" /> 1h ago
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onSelectTask('verification');
                }}
                className={`w-full px-3 py-1.5 text-left rounded-md flex flex-col gap-0.5 transition-all ${
                  activeTaskId === 'verification'
                    ? 'bg-white/10 text-white font-medium'
                    : 'hover:bg-white/[0.04] text-zinc-400'
                }`}
              >
                <span className="font-medium truncate text-xs">Run validation gates</span>
                <span className="text-[10px] text-zinc-500 flex items-center gap-1 font-mono">
                  <Clock className="w-2.5 h-2.5 text-zinc-600" /> 3h ago
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Footer Actions */}
      <div className="p-2 border-t border-white/5 flex flex-col gap-1 text-[11px]">
        <button
          type="button"
          className="flex items-center gap-2 px-2 py-1.5 text-zinc-500 hover:text-white rounded hover:bg-white/[0.03] transition-colors cursor-pointer text-left"
        >
          <FolderPlus className="w-3.5 h-3.5" />
          <span>Add repository</span>
        </button>
        <button
          type="button"
          className="flex items-center gap-2 px-2 py-1.5 text-zinc-500 hover:text-white rounded hover:bg-white/[0.03] transition-colors cursor-pointer text-left"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}
