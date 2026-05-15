/**
 * AppShell Component
 * Main workspace layout container with:
 * - Left panel: Run Inbox navigation
 * - Center panel: Active run workspace
 * - Right panel: Files, changes, artifacts, terminal tabs
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Resizer } from "../ui/Resizer";
import { RunInbox, type RunInboxItem } from "../run/RunInbox";
import { WorkspaceHeader } from "./WorkspaceHeader";
import type { AgentSession } from "../../hooks/useSessionManager";

interface AppShellProps {
  children: React.ReactNode;
  runs: RunInboxItem[];
  activeRunId: string | null;
  activeSession: AgentSession | undefined;
  onSelectRun: (runId: string, sessionId: string) => void;
  isRightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  leftPanelWidth?: number;
  onLeftPanelResize?: (delta: number) => void;
}

export function AppShell({
  children,
  runs,
  activeRunId,
  activeSession,
  onSelectRun,
  isRightSidebarOpen,
  onToggleRightSidebar,
  leftPanelWidth = 280,
  onLeftPanelResize,
}: AppShellProps) {
  return (
    <div className="flex h-full w-full bg-background text-zinc-400">
      {/* Left Panel: Run Inbox */}
      <div
        className="flex flex-col bg-zinc-950 border-r border-zinc-800 overflow-hidden"
        style={{ width: `${leftPanelWidth}px` }}
      >
        <div className="border-b border-zinc-800 p-3">
          <h2 className="text-sm font-semibold text-zinc-200">Runs</h2>
        </div>
        <RunInbox
          runs={runs}
          activeRunId={activeRunId}
          onSelectRun={onSelectRun}
        />
      </div>

      {/* Resizer between left and center */}
      {onLeftPanelResize && (
        <Resizer side="left" onResize={onLeftPanelResize} />
      )}

      {/* Center Panel: Main Workspace */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <WorkspaceHeader
          sessionName={activeSession?.name}
          repository={activeSession?.repository ?? undefined}
        />
        <div className="flex-1 overflow-auto bg-black">
          {children}
        </div>
      </div>

      {/* Right Panel Toggle */}
      <button
        onClick={onToggleRightSidebar}
        className="w-8 h-8 flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 border-l border-zinc-800 transition-colors"
        title={isRightSidebarOpen ? "Hide right panel" : "Show right panel"}
      >
        {isRightSidebarOpen ? (
          <ChevronRight className="w-4 h-4" />
        ) : (
          <ChevronLeft className="w-4 h-4" />
        )}
      </button>

      {/* Right Panel: Tabs (Files, Changes, Artifacts, Terminal) */}
      {isRightSidebarOpen && (
        <div className="w-80 bg-zinc-950 border-l border-zinc-800 flex flex-col overflow-hidden">
          <div className="border-b border-zinc-800">
            <div className="flex gap-1 p-2">
              <button className="px-2 py-1 text-xs font-medium text-blue-400 border-b border-blue-500 rounded-t">
                Files
              </button>
              <button className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-400 rounded-t">
                Changes
              </button>
              <button className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-400 rounded-t">
                Artifacts
              </button>
              <button className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-400 rounded-t">
                Terminal
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-3 text-sm text-zinc-500">
            <p>Files panel content (placeholder)</p>
          </div>
        </div>
      )}
    </div>
  );
}
