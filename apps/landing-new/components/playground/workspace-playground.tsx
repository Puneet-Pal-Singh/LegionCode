"use client";

import AgentChatPanel from "./agent-chat-panel";
import LeftSidebar from "./left-sidebar";
import ReviewPanel from "./review-panel";
import { usePlaygroundState } from "./playground-state";

function WindowHeader() {
  return (
    <div className="flex select-none items-center justify-between border-b border-white/5 bg-white/[0.04] px-4 py-3 backdrop-blur-md">
      <div className="flex items-center gap-2">
        {[0, 1, 2].map((item) => (
          <span
            key={item}
            className="h-3 w-3 rounded-full border border-white/5 bg-[#1c1c1c]"
          />
        ))}
        <span className="ml-4 select-none font-mono text-zinc-400">
          LegionCode — core-terminal
        </span>
      </div>
      <div className="flex items-center gap-1 font-mono text-[10px] text-zinc-500">
        <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
        <span>LOCAL ENGINE v1.2</span>
      </div>
    </div>
  );
}

function PlaygroundWindow() {
  const state = usePlaygroundState();
  return (
    <div className="flex h-[580px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0c0c0c]/45 font-sans text-xs text-zinc-300 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
      <WindowHeader />
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <LeftSidebar
          activeTaskId={state.activeTaskId}
          isOpen={state.isLeftSidebarOpen}
          onClose={state.closeLeftSidebar}
          onSelectTask={state.selectTask}
        />
        <AgentChatPanel
          activeTask={state.activeTask}
          chatMessages={state.chatMessages}
          inputValue={state.inputValue}
          isLeftSidebarOpen={state.isLeftSidebarOpen}
          isRightSidebarOpen={state.isRightSidebarOpen}
          isThinking={state.isThinking}
          onCloseSidebars={state.closeSidebars}
          onInputChange={state.setInputValue}
          onSendMessage={state.sendMessage}
          onToggleLeftSidebar={state.toggleLeftSidebar}
          onToggleRightSidebar={state.toggleRightSidebar}
          selectedModel="GPT 5.5"
        />
        <ReviewPanel
          activeTask={state.activeTask}
          expandedFiles={state.expandedFiles}
          isOpen={state.isRightSidebarOpen}
          onClose={state.closeRightSidebar}
          onToggleFile={state.toggleFile}
        />
      </div>
    </div>
  );
}

export default function WorkspacePlayground() {
  return (
    <div
      id="workspace"
      className="relative mx-auto mb-16 w-full max-w-5xl px-4 sm:px-6"
    >
      <div className="pointer-events-none absolute -inset-6 -z-10 rounded-3xl bg-gradient-to-tr from-white/5 via-neutral-500/5 to-white/5 opacity-70 blur-2xl" />
      <div className="pointer-events-none absolute top-1/2 -right-12 -z-10 h-64 w-64 rounded-full bg-white/5 blur-[90px]" />
      <div className="pointer-events-none absolute bottom-1/4 -left-12 -z-10 h-72 w-72 rounded-full bg-neutral-100/5 blur-[100px]" />
      <PlaygroundWindow />
    </div>
  );
}
