import { motion } from "framer-motion";
import { WorkspaceReviewControls, WorkspaceTopBar } from "@legioncode/client-ui";
import { OpenDropdown } from "../navigation/OpenDropdown";
import { GitHubLoginButton } from "../auth/GitHubLoginButton";
import { ChatHeaderMenu } from "../chat/ChatHeaderMenu";
import type { AgentSession } from "../../types/session";
import { TopEnvironmentSummary } from "../navigation/TopEnvironmentSummary";
import type { TopEnvironmentSummaryProps } from "../navigation/TopEnvironmentSummary";

interface TopNavBarProps {
  onOpenIde?: (ide: string) => void;
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
  environmentSummary?: TopEnvironmentSummaryProps;
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
  isRightSidebarOpen = false,
  onToggleRightSidebar,
  isAuthenticated = false,
  onConnectGitHub,
  environmentSummary,
  isMobile = false,
}: Pick<
  TopNavBarProps,
  | "onOpenIde"
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
        <WorkspaceReviewControls
          onToggleRightSidebar={onToggleRightSidebar}
        />
      ) : null}
    </div>
  );
}
