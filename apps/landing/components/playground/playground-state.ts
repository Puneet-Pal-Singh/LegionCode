import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ChatMessage } from "./agent-chat-panel";
import { MOCK_TASKS } from "./mock-tasks";

function buildAgentReply(input: string): string {
  const query = input.toLowerCase();
  if (query.includes("hello") || query.includes("hi")) {
    return "Hello! I am LegionCode's local workspace daemon. Tell me what you want to compose or refactor, and I will prepare the workspace task.";
  }
  if (query.includes("readme") || query.includes("documentation")) {
    return "I can polish your README.md. Select 'Sync Private Alpha README.md' to review a documentation change set.";
  }
  if (
    ["performance", "slow", "fast", "lint", "test"].some((term) =>
      query.includes(term),
    )
  ) {
    return "Select 'Run baseline validation gates' to inspect a sample boundary and type-check workflow.";
  }
  if (
    ["model", "gemini", "llm", "brain"].some((term) => query.includes(term))
  ) {
    return "LegionCode coordinates model and tool work through its Brain service and isolated execution environment.";
  }
  return "Tell me what files you want to update, or select a workspace task to review its sample diff.";
}

export function usePlaygroundState() {
  const taskState = usePlaygroundTaskState();
  const chatState = usePlaygroundChatState();
  const sidebarState = usePlaygroundSidebars();

  return {
    activeTask: taskState.activeTask,
    activeTaskId: taskState.activeTaskId,
    chatMessages: chatState.chatMessages,
    expandedFiles: taskState.expandedFiles,
    inputValue: chatState.inputValue,
    isLeftSidebarOpen: sidebarState.isLeftSidebarOpen,
    isRightSidebarOpen: sidebarState.isRightSidebarOpen,
    isThinking: chatState.isThinking,
    selectTask: taskState.selectTask,
    sendMessage: chatState.sendMessage,
    setInputValue: chatState.setInputValue,
    toggleFile: taskState.toggleFile,
    closeLeftSidebar: sidebarState.closeLeftSidebar,
    closeRightSidebar: sidebarState.closeRightSidebar,
    closeSidebars: sidebarState.closeSidebars,
    toggleLeftSidebar: sidebarState.toggleLeftSidebar,
    toggleRightSidebar: sidebarState.toggleRightSidebar,
  };
}

function usePlaygroundTaskState() {
  const [activeTaskId, setActiveTaskId] = useState("onboarding");
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>(
    {},
  );
  const activeTask = MOCK_TASKS[activeTaskId] ?? MOCK_TASKS.onboarding;
  const selectTask = (taskId: string) => {
    setActiveTaskId(taskId);
    setExpandedFiles({});
  };
  const toggleFile = (name: string) =>
    setExpandedFiles((current) => ({
      ...current,
      [name]: !(current[name] ?? name === activeTask.fileName),
    }));

  return { activeTask, activeTaskId, expandedFiles, selectTask, toggleFile };
}

function usePlaygroundChatState() {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const text = inputValue.trim();
    if (!text || isThinking) return;
    setChatMessages((current) => [...current, { sender: "user", text }]);
    setInputValue("");
    setIsThinking(true);
    timerRef.current = setTimeout(() => {
      setChatMessages((current) => [
        ...current,
        { sender: "agent", text: buildAgentReply(text) },
      ]);
      setIsThinking(false);
    }, 1_800);
  };

  return { chatMessages, inputValue, isThinking, sendMessage, setInputValue };
}

function usePlaygroundSidebars() {
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);

  return {
    isLeftSidebarOpen,
    isRightSidebarOpen,
    closeLeftSidebar: () => setIsLeftSidebarOpen(false),
    closeRightSidebar: () => setIsRightSidebarOpen(false),
    closeSidebars: () => {
      setIsLeftSidebarOpen(false);
      setIsRightSidebarOpen(false);
    },
    toggleLeftSidebar: () => {
      setIsLeftSidebarOpen((open) => !open);
      setIsRightSidebarOpen(false);
    },
    toggleRightSidebar: () => {
      setIsRightSidebarOpen((open) => !open);
      setIsLeftSidebarOpen(false);
    },
  };
}
