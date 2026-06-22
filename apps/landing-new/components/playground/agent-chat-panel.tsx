"use client";

import type { FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronRight,
  Clock,
  CornerDownLeft,
  PanelLeft,
  PanelRight,
} from "lucide-react";
import type { MockTask } from "./types";

export interface ChatMessage {
  sender: "user" | "agent";
  text: string;
}

interface AgentChatPanelProps {
  activeTask: MockTask;
  chatMessages: ChatMessage[];
  inputValue: string;
  isLeftSidebarOpen: boolean;
  isRightSidebarOpen: boolean;
  isThinking: boolean;
  onCloseSidebars: () => void;
  onInputChange: (value: string) => void;
  onSendMessage: (event: FormEvent) => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  selectedModel: string;
}

function PanelHeader({
  activeTask,
  onToggleLeft,
  onToggleRight,
}: {
  activeTask: MockTask;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/5 bg-white/[0.02] px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleLeft}
          aria-label="Toggle workspaces"
          className="flex shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 p-1.5 text-zinc-400 transition-all hover:bg-white/10 hover:text-white lg:hidden"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="max-w-[150px] truncate font-semibold text-white sm:max-w-[280px]">
          {activeTask.title}
        </span>
        <span className="shrink-0 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
          ACTIVE
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleRight}
          aria-label="Toggle review diff"
          className="flex shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 p-1.5 text-zinc-400 transition-all hover:bg-white/10 hover:text-white lg:hidden"
        >
          <PanelRight className="h-4 w-4" />
        </button>
        <span
          aria-hidden="true"
          className="select-none px-1 text-sm font-bold leading-none text-zinc-500"
        >
          ···
        </span>
      </div>
    </div>
  );
}

function TaskSummary({ task }: { task: MockTask }) {
  const files = task.filesList ?? [{ name: task.fileName, ...task.changes }];
  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-3.5 shadow-lg shadow-black/30 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-white/10 font-mono text-[10px] font-bold text-white">
          _&gt;
        </div>
        <span className="font-mono font-semibold text-white">
          LegionCode Workspace Agent
        </span>
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
          Local Compiler Node
        </span>
      </div>
      <p className="font-mono text-[11px] leading-relaxed text-zinc-300">
        {task.message}
      </p>
      <div className="space-y-2 border-t border-white/5 pt-2 text-[11px]">
        <div className="flex items-center gap-2 font-mono text-[10.5px] text-zinc-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          <span>
            {files.length} {files.length === 1 ? "file" : "files"} changed
          </span>
        </div>
        <div className="flex w-full flex-col gap-1 font-mono text-[10px]">
          {files.map((file) => (
            <div
              key={file.name}
              className="flex w-full items-center justify-between rounded border border-white/5 bg-white/[0.02] px-2.5 py-1 text-zinc-400 transition-colors hover:bg-white/[0.04]"
            >
              <span className="truncate pr-4 text-[10.5px] text-zinc-450">
                {file.name}
              </span>
              <span className="flex shrink-0 gap-2.5 text-[10.5px] font-medium">
                <span className="text-emerald-500">+{file.added}</span>
                <span className="text-rose-500">-{file.removed}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageList({
  isThinking,
  messages,
}: {
  isThinking: boolean;
  messages: ChatMessage[];
}) {
  return (
    <>
      <AnimatePresence initial={false}>
        {messages.map((message, index) => (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            key={`${message.sender}-${index}-${message.text}`}
            className={`flex gap-3 leading-relaxed ${message.sender === "user" ? "justify-end" : "justify-start"}`}
          >
            {message.sender === "agent" && (
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-white/10 bg-white/10 font-mono text-[10px] font-bold text-white">
                _&gt;
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-xl p-3 text-[11px] backdrop-blur-md ${message.sender === "user" ? "border border-white/15 bg-white/10 text-white" : "border border-white/5 bg-white/5 text-zinc-300"}`}
            >
              <p
                className={
                  message.sender === "user"
                    ? "select-all font-mono text-zinc-300"
                    : undefined
                }
              >
                {message.sender === "user" ? `> ${message.text}` : message.text}
              </p>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {isThinking && (
        <div className="flex select-none items-center gap-2 pl-8 text-[10.5px] italic text-zinc-500">
          <span className="h-2 w-2 animate-ping rounded-full bg-white/80" />
          <span>Workspace compiler thinking...</span>
        </div>
      )}
    </>
  );
}

function Composer({
  inputValue,
  onInputChange,
  onSubmit,
  selectedModel,
}: {
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  selectedModel: string;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="shrink-0 border-t border-white/5 bg-[#0d0d0d]/30 p-3 backdrop-blur-md"
    >
      <div className="flex flex-col rounded-xl border border-white/10 bg-white/[0.02] shadow-inner transition-all focus-within:border-white/20">
        <input
          aria-label="Ask LegionCode"
          type="text"
          className="w-full border-0 bg-transparent px-3 py-2.5 font-mono text-[11.5px] text-white outline-none placeholder-zinc-500"
          placeholder="Ask LegionCode anything, @ to add files, / for commands..."
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
        />
        <div className="flex select-none items-center justify-between px-2.5 pb-2.5 pt-1.5">
          <div className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[10px] text-zinc-300">
            <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
            <span>{selectedModel}</span>
          </div>
          <button
            type="submit"
            aria-label="Send message"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-black shadow-md transition-colors hover:bg-zinc-105"
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </form>
  );
}

export default function AgentChatPanel(props: AgentChatPanelProps) {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-white/[0.01] backdrop-blur-lg">
      <PanelHeader
        activeTask={props.activeTask}
        onToggleLeft={props.onToggleLeftSidebar}
        onToggleRight={props.onToggleRightSidebar}
      />
      {(props.isLeftSidebarOpen || props.isRightSidebarOpen) && (
        <button
          type="button"
          aria-label="Close open panel"
          className="absolute inset-0 z-20 bg-black/50 backdrop-blur-[1.5px] lg:hidden"
          onClick={props.onCloseSidebars}
        />
      )}
      <div className="no-scrollbar flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex select-none items-center gap-2 text-zinc-500">
          <Clock className="h-3.5 w-3.5 text-zinc-600" />
          <span>
            Worked for{" "}
            <span className="font-mono font-medium text-white">
              {props.activeTask.duration}
            </span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-zinc-700" />
        </div>
        <TaskSummary task={props.activeTask} />
        <MessageList
          isThinking={props.isThinking}
          messages={props.chatMessages}
        />
      </div>
      <Composer
        inputValue={props.inputValue}
        onInputChange={props.onInputChange}
        onSubmit={props.onSendMessage}
        selectedModel={props.selectedModel}
      />
    </div>
  );
}
