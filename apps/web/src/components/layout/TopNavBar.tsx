import { motion } from "framer-motion";
import { FileDiff, PanelRight } from "lucide-react";
import { WorkspaceTopBar } from "@legioncode/client-ui";
import { OpenDropdown } from "../navigation/OpenDropdown";
import { GitHubLoginButton } from "../auth/GitHubLoginButton";
import { ChatHeaderMenu } from "../chat/ChatHeaderMenu";
import type { AgentSession } from "../../types/session";
import type { Repository } from "../../services/GitHubService";
import type { HostedSessionPullRequestsResponse } from "@legioncode/sdk";
import type { SavedChatSourcesProjection } from "../../lib/saved-chat-sources";
import { TopEnvironmentSummary } from "../navigation/TopEnvironmentSummary";

interface TopNavBarProps {
  onOpenIde?: (ide: string) => void;
  onReview?: () => void;
  isRightSidebarOpen?: boolean;
  onToggleRightSidebar?: () => void;
  threadTitle?: string;
  taskTitle?: string;
  activeSession?: AgentSession | null;
  onRenameSession?: (sessionId: string, title: string) => Promise<void>;
  onPinSession?: () => Promise<void>;
  onUnpinSession?: () => Promise<void>;
  onArchiveSession?: () => Promise<void>;
  isAuthenticated?: boolean;
  onConnectGitHub?: () => void;
  environmentSummary?: {
    repo: Repository | null;
    branch: string;
    pullRequestResult?: HostedSessionPullRequestsResponse;
    savedSources?: SavedChatSourcesProjection;
    changedFileCount?: number;
    onBranchChange?: (branch: string) => void;
    onOpenChanges?: () => void;
    onOpenCommit?: () => void;
    onOpenSources?: () => void;
    onOpen?: () => void;
  };
  isMobile?: boolean;
}

export function TopNavBar(props: TopNavBarProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex min-w-0 flex-1 items-center"
    >
      <WorkspaceTopBar
        title={props.taskTitle ?? props.threadTitle}
        leading={<TopNavSessionActions {...props} />}
        actions={<TopNavActions {...props} />}
      />
    </motion.div>
  );
}

function TopNavSessionActions({
  activeSession,
  onRenameSession,
  onPinSession,
  onUnpinSession,
  onArchiveSession,
  isMobile,
}: Pick<
  TopNavBarProps,
  | "activeSession"
  | "onRenameSession"
  | "onPinSession"
  | "onUnpinSession"
  | "onArchiveSession"
  | "isMobile"
>) {
  return (
    <div className="flex min-w-0 items-center">
      {!isMobile ? (
        <ChatHeaderMenu
          session={activeSession ?? null}
          onRename={onRenameSession ?? (async () => undefined)}
          onPin={onPinSession ?? (async () => undefined)}
          onUnpin={onUnpinSession ?? (async () => undefined)}
          onArchive={onArchiveSession ?? (async () => undefined)}
        />
      ) : null}
    </div>
  );
}

function TopNavActions({
  onOpenIde,
  onReview,
  isRightSidebarOpen = false,
  onToggleRightSidebar,
  isAuthenticated = false,
  onConnectGitHub,
  environmentSummary,
  isMobile = false,
}: Pick<
  TopNavBarProps,
  | "onOpenIde"
  | "onReview"
  | "isRightSidebarOpen"
  | "onToggleRightSidebar"
  | "isAuthenticated"
  | "onConnectGitHub"
  | "environmentSummary"
  | "isMobile"
>) {
  return (
    <div
      data-testid="top-nav-actions"
      className="flex shrink-0 items-center gap-2"
    >
      {!isAuthenticated && onConnectGitHub ? (
        <GitHubLoginButton
          onClick={onConnectGitHub}
          size="sm"
          variant="secondary"
        />
      ) : null}
      {!isMobile ? (
        <OpenDropdown onSelect={onOpenIde} disabled={!onOpenIde} />
      ) : null}
      {environmentSummary ? (
        <TopEnvironmentSummary {...environmentSummary} />
      ) : null}
      {!isRightSidebarOpen ? (
        <ReviewControls
          onReview={onReview}
          onToggleRightSidebar={onToggleRightSidebar}
        />
      ) : null}
    </div>
  );
}

function ReviewControls({
  onReview,
  onToggleRightSidebar,
}: {
  onReview?: () => void;
  onToggleRightSidebar?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
      <motion.button
        onClick={onReview}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        disabled={!onReview}
        aria-label="Review"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition-all hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
        title={onReview ? "Open review panel" : "Review is not available yet"}
      >
        <FileDiff size={15} />
      </motion.button>
      <motion.button
        onClick={onToggleRightSidebar}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        disabled={!onToggleRightSidebar}
        aria-label="Toggle right sidebar"
        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
        title="Toggle right sidebar"
      >
        <PanelRight size={17} />
      </motion.button>
    </div>
  );
}
