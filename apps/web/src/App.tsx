import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ClientShell,
  ClientShellLoading,
  WorkspaceFrame,
  type AppServerEnvironmentSnapshot,
} from "@legioncode/client-ui";
import { motion, AnimatePresence } from "framer-motion";
import { useSessionManager } from "./hooks/useSessionManager";
import { useSessionPullRequests } from "./hooks/useSessionPullRequests";
import type { SavedChatSourcesProjection } from "./lib/saved-chat-sources";
import { AgentSidebar } from "./components/layout/AgentSidebar";
import { Workspace } from "./components/layout/Workspace";
import { SessionConversationSurface } from "./components/layout/SessionConversationSurface";
import { TabType } from "./components/layout/workspace/useWorkspaceState";
import { AgentSetup } from "./components/agent/AgentSetup";
import { TopNavBar } from "./components/layout/TopNavBar";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import {
  GitHubContextProvider,
  useGitHub,
} from "./components/github/GitHubContextProvider";
import { AuthorizedRepositoryPicker } from "./components/github/AuthorizedRepositoryPicker";
import type {
  Repository,
} from "./services/GitHubService";
import * as WorkspaceSelection from "./services/api/workspaceSelection";
import { Resizer } from "./components/ui/Resizer";
import { uiShellStore } from "./store/uiShellStore";
import type { RunInboxItem } from "./components/run/RunInbox";
import { SessionStateService } from "./services/SessionStateService";
import { RunContextProvider } from "./hooks/useRunContext";
import { useProviderStore } from "./hooks/useProviderStore";
import {
  isSessionContextPending,
  resolveShellStartupState,
} from "./lib/startup-shell-state";
import { doesSessionContextMatchRepository } from "./lib/repository-context-match";
import { resolveTaskRepositoryFullName } from "./lib/session-github-context";
import type { SetupSessionState } from "./types/session";
import { GitHubSignInPage } from "./components/onboarding/GitHubSignInPage";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import {
  subscribeToOpenSettingsDialog,
  type SettingsSection,
} from "./lib/settings-dialog-events";
import type { HookSettingsAuditReadModel } from "./services/api/lifecycleClient.js";
import { initializeHostedAppServer } from "./services/api/appServerClient";
import { useSessionWorkspaceContext } from "./hooks/useSessionWorkspaceContext";
import { saveSessionBranchPreference } from "./lib/session-branch-preference";
import {
  createInitialPromptSubmissionId,
  type InitialPromptSubmission,
  type InitialPromptSubmissionId,
  type InitialPromptSubmissionStatus,
} from "./lib/initial-prompt-submission";
import { useWorkspaceSelectionBootstrap } from "./hooks/useWorkspaceSelectionBootstrap";
import { useWorkspaceViewport } from "./hooks/useWorkspaceViewport";
import { isSessionPersistenceReady } from "./lib/session-persistence";
import {
  retireSessionSubmissionAttempts,
  retireSubmissionIntent,
} from "./hooks/chat/submissionAttemptRegistry";

const DEFAULT_LEFT_SIDEBAR_WIDTH = 320;
const MIN_RIGHT_SIDEBAR_WIDTH = 420;
const MAX_RIGHT_SIDEBAR_WIDTH = 720;

const HOSTED_ENVIRONMENT: AppServerEnvironmentSnapshot = {
  kind: "hosted",
  status: "starting",
  protocolVersion: null,
  serverVersion: null,
  capabilities: [],
  unavailableCapabilities: [],
  reason: "Checking hosted App Server",
};

function getInitialRightSidebarWidth(): number {
  const availableWidth = window.innerWidth - DEFAULT_LEFT_SIDEBAR_WIDTH;
  return Math.max(
    MIN_RIGHT_SIDEBAR_WIDTH,
    Math.min(MAX_RIGHT_SIDEBAR_WIDTH, Math.round(availableWidth * 0.42)),
  );
}

/**
 * Main App Component
 * Wraps everything in AuthProvider and GitHubContextProvider
 */
function RedirectToAgents({ target }: { target: string }) {
  useEffect(() => {
    window.location.replace(target);
  }, [target]);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-black text-sm text-zinc-500">
      Opening LegionCode agents...
    </div>
  );
}

const LEGACY_APP_ALIASES = new Set(["/app", "/web-agents"]);

function isLegacyAppAlias(pathname: string): boolean {
  const normalized = pathname.trim().replace(/\/+$/, "") || "/";
  return LEGACY_APP_ALIASES.has(normalized);
}

function App() {
  const { pathname, search, hash } = window.location;

  if (isLegacyAppAlias(pathname)) {
    return <RedirectToAgents target={`/agents${search}${hash}`} />;
  }

  return (
    <AuthProvider>
      <GitHubContextProvider>
        <AppContent />
      </GitHubContextProvider>
    </AuthProvider>
  );
}

/**
 * App Content - Contains the main application logic
 * Separated to allow useAuth hook access within AuthProvider
 */
function AppContent() {
  const [environment, setEnvironment] =
    useState<AppServerEnvironmentSnapshot>(HOSTED_ENVIRONMENT);
  useEffect(() => {
    void initializeHostedAppServer()
      .then((handshake) => {
        setEnvironment({
          kind: handshake.environment,
          status: "ready",
          protocolVersion: handshake.protocolVersion,
          serverVersion: handshake.server.version,
          capabilities: handshake.capabilities,
          unavailableCapabilities: handshake.unavailableCapabilities,
          reason: null,
        });
      })
      .catch(() => {
        setEnvironment({
          ...HOSTED_ENVIRONMENT,
          status: "degraded",
          reason: "Hosted App Server status is unavailable",
        });
      });
  }, []);
  const { isAuthenticated, isLoading, login, logout, user } =
    useAuth();
  const {
    sessions,
    activeSessionId,
    sessionHydrationStatus,
    setActiveSessionId,
    createSession,
    retrySessionPersistence,
    renameSession,
    refreshSessionProjection,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    acknowledgeSession,
    updateSession,
    repositories,
    removeRepository,
    renameRepository,
  } = useSessionManager({
    hydrateFromServer: isAuthenticated && !isLoading,
  });
  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const activeSourcesKey = activeSessionId
    ? `${user?.id ?? "anonymous-account"}\0${activeSessionId}`
    : null;
  const [savedSourcesSnapshot, setSavedSourcesSnapshot] = useState<{
    key: string;
    projection: SavedChatSourcesProjection;
  } | null>(null);
  const handleSavedSourcesChange = useCallback(
    (projection: SavedChatSourcesProjection) => {
      if (!activeSourcesKey) return;
      const key = activeSourcesKey;
      setSavedSourcesSnapshot((current) =>
        current?.key === key && current.projection === projection
          ? current
          : { key, projection },
      );
    },
    [activeSourcesKey],
  );
  const activeSavedSources: SavedChatSourcesProjection =
    savedSourcesSnapshot?.key === activeSourcesKey
      ? savedSourcesSnapshot.projection
      : {
          images: [],
          status: activeSessionId ? "loading" : "ready",
          error: null,
        };
  const [visibleSessionIds, setVisibleSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const requestedPullRequestSessionIds = useMemo(() => {
    const requested = new Set(visibleSessionIds);
    if (activeSessionId) requested.add(activeSessionId);
    return requested;
  }, [activeSessionId, visibleSessionIds]);
  const { pullRequestsBySessionId, prioritizeSession } = useSessionPullRequests(
    sessions,
    requestedPullRequestSessionIds,
    user?.id ?? null,
  );
  const handleVisibleSessionChange = useCallback(
    (selectionId: string, visible: boolean) => {
      setVisibleSessionIds((current) => {
        if (current.has(selectionId) === visible) return current;
        const next = new Set(current);
        if (visible) next.add(selectionId);
        else next.delete(selectionId);
        return next;
      });
    },
    [],
  );
  const handlePreviewSessionChange = useCallback(
    (selectionId: string | null) => {
      prioritizeSession(selectionId ?? activeSessionId, selectionId !== null);
    },
    [activeSessionId, prioritizeSession],
  );
  const { repo, branch, switchBranch, setContext, clearContext } = useGitHub();
  const activeSessionIdRef = useRef(activeSessionId);
  const repoFullNameRef = useRef(repo?.full_name ?? null);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    repoFullNameRef.current = repo?.full_name ?? null;
  }, [activeSessionId, repo?.full_name]);
  const workspaceSelectionBootstrapStatus = useWorkspaceSelectionBootstrap({
    enabled: isAuthenticated && !isLoading && !activeSession,
    currentRepository: repo,
    setContext,
  });
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [isGitReviewOpen, setIsGitReviewOpen] = useState(false);
  const [gitReviewSessionId, setGitReviewSessionId] = useState<string | null>(
    null,
  );
  const [reviewSidebarFocusRequest, setReviewSidebarFocusRequest] = useState(0);
  const [summaryActionRequest, setSummaryActionRequest] = useState<{
    id: number;
    action: "changes" | "commit" | "sources";
  } | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    try {
      const stored = localStorage.getItem("legioncode_active_tab");
      if (stored === "review" || stored === "changes" || stored === "files") {
        return stored as TabType;
      }
    } catch (error) {
      console.warn("[App] Failed to read active tab state:", error);
    }
    return "files";
  });
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsSection>("general");
  const [hookSettingsContext, setHookSettingsContext] = useState<{
    sessionId: string;
    workspaceId: string;
    audits: readonly HookSettingsAuditReadModel[];
  } | null>(null);
  const handleHookSettingsContextChange = useCallback(
    (context: {
      workspaceId: string;
      audits: readonly HookSettingsAuditReadModel[];
    }) => {
      if (!activeSessionId) return;
      setHookSettingsContext({
        sessionId: activeSessionId,
        ...context,
      });
    },
    [activeSessionId],
  );
  const { context: sessionWorkspaceContext, isLoading: isWorkspaceContextRepairing,
    isResolved: isWorkspaceContextResolved,
    setContext: setSessionWorkspaceContext } = useSessionWorkspaceContext({
    authenticated: isAuthenticated,
    sessionId: activeSession?.id ?? null,
    persistenceReady: Boolean(activeSession && isSessionPersistenceReady(activeSession.persistenceStatus)),
    updateSession,
  });

  const openSettingsDialog = useCallback(
    (section: SettingsSection = "general") => {
      setSettingsInitialSection(section);
      setIsSettingsDialogOpen(true);
    },
    [setSettingsInitialSection, setIsSettingsDialogOpen],
  );

  const setupSession = useMemo<SetupSessionState | null>(() => {
    if (!isAuthenticated || sessions.length > 0) {
      return null;
    }

    return (
      SessionStateService.loadSetupSession() ??
      SessionStateService.createSetupSession()
    );
  }, [isAuthenticated, sessions.length]);
  const providerScopeSession = activeSession ?? sessions[0] ?? null;
  const providerScopeRunId =
    providerScopeSession?.activeRunId ??
    providerScopeSession?.latestRunId ??
    setupSession?.activeRunId;
  const {
    credentials,
    reset: resetProviderStore,
  } = useProviderStore(isAuthenticated ? providerScopeRunId : undefined);

  // Convert sessions to run inbox items for shell navigation
  // This supports the run-centric UI model and will be passed to AppShell in future PRs
  // TODO: Use this in AppShell integration (PR 04)
  // @ts-expect-error - intentionally unused, will be used in next PR
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const convertSessionsToRuns = (): RunInboxItem[] => {
    return sessions.flatMap((session) => {
      if (!session.activeRunId) return [];
      let status:
        | "idle"
        | "queued"
        | "running"
        | "waiting"
        | "paused"
        | "failed"
        | "complete" = "idle";
      if (session.status === "running") status = "running";
      else if (session.status === "waiting_for_approval") status = "waiting";
      else if (session.status === "completed") status = "complete";
      else if (session.status === "paused") {
        status = "paused";
      } else if (session.status === "failed") {
        status = "failed";
      }

      // Get session's last update time from localStorage or use current time
      const sessionUpdateKey = `session_updated_at_${session.id}`;
      const savedUpdateTime = localStorage.getItem(sessionUpdateKey);
      const updatedAt = savedUpdateTime || new Date().toISOString();

      return [
        {
          runId: session.activeRunId,
          sessionId: session.id,
          title: session.name,
          status,
          updatedAt,
          repository: session.repository ?? "No repository",
        },
      ];
    });
  };

  // Sync UI shell store with active session
  useEffect(() => {
    if (!activeSessionId) return;

    const storeState = uiShellStore.getState();

    if (storeState.activeSessionId !== activeSessionId) {
      uiShellStore.setActiveSessionId(activeSessionId);
    }

    // Keep the selected run in sync when resume or queue admission creates a new run.
    if (activeSession && storeState.activeRunId !== activeSession.activeRunId) {
      uiShellStore.setActiveRunId(activeSession.activeRunId);
    }
  }, [activeSessionId, activeSession]);

  const clearSetupSessionState = useCallback(() => {
    SessionStateService.clearSetupSession();
  }, []);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (!isAuthenticated) {
      clearSetupSessionState();
      resetProviderStore();
      return;
    }

    if (sessions.length > 0) {
      clearSetupSessionState();
      return;
    }

    if (setupSession) {
      SessionStateService.saveSetupSession(setupSession);
    }
  }, [
    clearSetupSessionState,
    isAuthenticated,
    isLoading,
    resetProviderStore,
    sessions.length,
    setupSession,
  ]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const { isCompact, isMobile } = useWorkspaceViewport();
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(() => {
    return localStorage.getItem("legioncode_right_sidebar_open") === "true";
  });
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_LEFT_SIDEBAR_WIDTH);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(
    getInitialRightSidebarWidth,
  );
  const [initialPromptSubmissions, setInitialPromptSubmissions] = useState<
    Record<string, InitialPromptSubmission>
  >({});
  const initialPromptSubmissionsRef = useRef(initialPromptSubmissions);
  const updateInitialPromptSubmissions = useCallback(
    (
      update: (
        current: Record<string, InitialPromptSubmission>,
      ) => Record<string, InitialPromptSubmission>,
    ) => {
      const next = update(initialPromptSubmissionsRef.current);
      initialPromptSubmissionsRef.current = next;
      setInitialPromptSubmissions(next);
    },
    [],
  );
  const claimInitialPrompt = useCallback(
    (sessionId: string, id: InitialPromptSubmissionId): boolean => {
      const current = initialPromptSubmissionsRef.current[sessionId];
      if (current?.id !== id || current.status !== "queued") {
        return false;
      }
      updateInitialPromptSubmissions((submissions) => ({
        ...submissions,
        [sessionId]: { ...current, status: "submitting" },
      }));
      return true;
    },
    [updateInitialPromptSubmissions],
  );
  const updateInitialPromptStatus = useCallback(
    (
      sessionId: string,
      id: InitialPromptSubmissionId,
      status: InitialPromptSubmissionStatus,
    ) => {
      const current = initialPromptSubmissionsRef.current[sessionId];
      if (current?.id !== id || current.status !== "submitting") return;
      updateInitialPromptSubmissions((submissions) => ({
        ...submissions,
        [sessionId]: { ...current, status },
      }));
    },
    [updateInitialPromptSubmissions],
  );
  const settleInitialPrompt = useCallback(
    (sessionId: string, id: InitialPromptSubmissionId) => {
      const current = initialPromptSubmissionsRef.current[sessionId];
      if (current?.id !== id) return;
      retireSubmissionIntent(sessionId, `client_msg_${id}`);
      updateInitialPromptSubmissions((submissions) => {
        const next = { ...submissions };
        delete next[sessionId];
        return next;
      });
    },
    [updateInitialPromptSubmissions],
  );
  const retryInitialPrompt = useCallback(
    (sessionId: string, id: InitialPromptSubmissionId) => {
      const current = initialPromptSubmissionsRef.current[sessionId];
      if (current?.id !== id || current.status !== "failed") return;
      updateInitialPromptSubmissions((submissions) => ({
        ...submissions,
        [sessionId]: { ...current, status: "queued" },
      }));
    },
    [updateInitialPromptSubmissions],
  );
  const retireSessionInitialPrompt = useCallback(
    (sessionId: string) => {
      retireSessionSubmissionAttempts(sessionId);
      const current = initialPromptSubmissionsRef.current[sessionId];
      if (current) settleInitialPrompt(sessionId, current.id);
    },
    [settleInitialPrompt],
  );

  useEffect(() => {
    localStorage.setItem(
      "legioncode_right_sidebar_open",
      String(isRightSidebarOpen),
    );
  }, [isRightSidebarOpen]);

  useEffect(() => {
    if (!isCompact) return;
    const frame = requestAnimationFrame(() => {
      setIsSidebarOpen(false);
      setIsRightSidebarOpen(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [isCompact]);

  useEffect(() => {
    localStorage.setItem("legioncode_active_tab", activeTab);
  }, [activeTab]);

  const hasProviderConnection = isAuthenticated && credentials.length > 0;
  const hasRealSession = sessions.length > 0;
  const hasRepoContext =
    Boolean(repo?.full_name) ||
    sessions.some((session) => (session.repository?.trim() ?? "").length > 0);
  const hasMatchingActiveWorkspaceContext = Boolean(
    repo?.full_name &&
    activeSession &&
    sessionWorkspaceContext?.sessionId === activeSession.id &&
    sessionWorkspaceContext.workspaceId &&
    sessionWorkspaceContext.workspaceStatus === "active" &&
    doesSessionContextMatchRepository(activeSession.repository, {
      fullName: repo.full_name,
      repoName: repo.name,
    }),
  );
  const hasSetupRun = Boolean(setupSession?.activeRunId);
  const shellStartupState = useMemo(
    () =>
      resolveShellStartupState({
        isAuthenticated,
        hasSetupRun,
        hasProviderConnection,
        hasRepoContext,
        hasRealSession,
      }),
    [
      hasProviderConnection,
      hasRealSession,
      hasRepoContext,
      hasSetupRun,
      isAuthenticated,
    ],
  );
  const showShellSetupSurface =
    isAuthenticated &&
    !activeSession &&
    (shellStartupState === "shell_authenticated_setup" ||
      shellStartupState === "shell_authenticated_repo_missing");
  const isPreparingSetupShell = showShellSetupSurface && setupSession === null;

  // Get active session name for the header
  const taskTitle = activeSession?.name;
  const threadTitle = activeSession?.name;

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string): Promise<void> => {
      await renameSession(sessionId, title);
    },
    [renameSession],
  );

  const handlePinActiveSession = useCallback(async (): Promise<void> => {
    if (activeSessionId) {
      await pinSession(activeSessionId);
    }
  }, [activeSessionId, pinSession]);

  const handleUnpinActiveSession = useCallback(async (): Promise<void> => {
    if (activeSessionId) {
      await unpinSession(activeSessionId);
    }
  }, [activeSessionId, unpinSession]);

  const handleArchiveActiveSession = useCallback(async (): Promise<void> => {
    if (activeSessionId) {
      if (await archiveSession(activeSessionId)) {
        retireSessionInitialPrompt(activeSessionId);
      }
    }
  }, [activeSessionId, archiveSession, retireSessionInitialPrompt]);

  const handleOpenRepositoryPicker = () => {
    if (!isAuthenticated) {
      login();
      return;
    }

    setShowRepoPicker(true);
  };

  useEffect(() => {
    return subscribeToOpenSettingsDialog((section) => {
      openSettingsDialog(section);
    });
  }, [openSettingsDialog]);

  const handleNewTask = async (repositoryName?: string) => {
    if (!isAuthenticated) {
      login();
      return;
    }

    setIsGitReviewOpen(false);
    setGitReviewSessionId(null);

    // If no repo name provided, try to use the currently active repo.
    // Bare sidebar labels cannot load branches or bootstrap git safely.
    const targetRepo = resolveTaskRepositoryFullName(repositoryName, repo);

    if (targetRepo) {
      setShowRepoPicker(false);
      let workspaceId = sessionWorkspaceContext?.sessionId === activeSessionId &&
        sessionWorkspaceContext.workspaceStatus === "active" &&
        doesSessionContextMatchRepository(targetRepo, {
          fullName: sessionWorkspaceContext.repository?.fullName,
          repoName: sessionWorkspaceContext.repository?.name,
        }) ? sessionWorkspaceContext.workspaceId ?? undefined : undefined;
      if (!workspaceId) {
        const workspaces = await WorkspaceSelection.listWorkspaces();
        const matches = workspaces.workspaces.filter((item) =>
          item.workspace.status === "active" &&
          doesSessionContextMatchRepository(targetRepo, {
            fullName: item.repository.fullName,
            repoName: item.repository.name,
          }),
        );
        if (matches.length === 1) workspaceId = matches[0]!.workspace.id;
      }
      if (!workspaceId) {
        handleOpenRepositoryPicker();
        return;
      }
      // Create the durable conversation before exposing setup/submit controls.
      const sessionName = `New Task`;
      try {
        await createSession(sessionName, targetRepo, undefined, workspaceId);
      } catch (error) {
        console.warn("[session/create] Failed to persist session:", error);
        return;
      }
      clearSetupSessionState();

    } else {
      // If absolutely no repo is selected, targetRepo is missing,
      // or the user has deleted the repo folder
      handleOpenRepositoryPicker();
    }
  };

  const handleChooseExistingProject = (repository: string) => {
    handleNewTask(repository);
  };

  const handleChooseNoProject = async () => {
    try {
      await createSession("New Task", "New Project");
      clearContext();
      clearSetupSessionState();
    } catch (error) {
      console.warn("[session/create] Failed to persist session:", error);
    }
  };

  const handleExplicitBranchSelect = useCallback(async (nextBranch: string) => {
    if (!repo) return;
    const sessionId = activeSessionId;
    const fullName = repo.full_name;
    await WorkspaceSelection.selectWorkspace(repo, nextBranch);
    if (activeSessionIdRef.current !== sessionId || repoFullNameRef.current !== fullName) return;
    switchBranch(nextBranch);
    if (sessionId) saveSessionBranchPreference(sessionId, fullName, nextBranch);
    setSessionWorkspaceContext((current) => current?.sessionId === sessionId
      ? { ...current, selectedBranch: nextBranch }
      : current);
  }, [activeSessionId, repo, switchBranch, setSessionWorkspaceContext]);

  const environmentSummary = activeSession
    ? {
        repo: !isWorkspaceContextRepairing && hasMatchingActiveWorkspaceContext
          ? repo
          : null,
        branch: !isWorkspaceContextRepairing && hasMatchingActiveWorkspaceContext
          ? branch
          : "",
        pullRequestResult: user?.id
          ? pullRequestsBySessionId.get(activeSession.id)
          : { status: "unavailable" as const, sessionId: activeSession.id },
        savedSources: activeSavedSources,
        onOpen: () => prioritizeSession(activeSession.id, true),
        onOpenSources:
          isSessionPersistenceReady(activeSession.persistenceStatus) &&
          (activeSavedSources.images.length > 0 ||
            activeSavedSources.status !== "ready")
            ? () =>
                setSummaryActionRequest({
                  id: Date.now(),
                  action: "sources",
                })
            : undefined,
        ...(!isWorkspaceContextRepairing && hasMatchingActiveWorkspaceContext
          ? {
              onBranchChange: (nextBranch: string) => {
                void handleExplicitBranchSelect(nextBranch);
              },
            }
          : {}),
      }
    : undefined;

  const focusReviewSidebar = () => {
    setReviewSidebarFocusRequest((previous) => previous + 1);
  };

  const handleOpenReviewSidebar = () => {
    if (isRightSidebarOpen && activeTab === "review") {
      setIsRightSidebarOpen(false);
    } else {
      setIsGitReviewOpen(false);
      setGitReviewSessionId(null);
      setIsRightSidebarOpen(true);
      focusReviewSidebar();
    }
  };

  const handleToggleRightSidebar = () => {
    setIsRightSidebarOpen((previous) => !previous);
  };

  const handleSelectSession = (sessionId: string) => {
    if (sessionId !== activeSessionId) {
      setIsGitReviewOpen(false);
      setGitReviewSessionId(null);
    }
    setActiveSessionId(sessionId);
    void acknowledgeSession(sessionId);
    if (isCompact) setIsSidebarOpen(false);
  };

  /**
   * Handle repository selection from RepoPicker
   * Creates a session immediately for the selected repository
   */
  const handleRepoSelect = async (
    selectedRepo: Repository,
    selectedBranch: string,
  ): Promise<void> => {
    let selection: WorkspaceSelection.WorkspaceSelection;
    try {
      selection = await WorkspaceSelection.selectWorkspace(selectedRepo, selectedBranch);
    } catch (error) {
      console.error("[workspace/select] Failed to persist selection:", error);
      window.dispatchEvent(
        new CustomEvent("legioncode:workspace-selection-persist-failed", {
          detail: {
            repository: selectedRepo.full_name,
            branch: selectedBranch,
          },
        }),
      );
      throw error;
    }

    setIsGitReviewOpen(false);
    setGitReviewSessionId(null);
    setContext(selectedRepo, selectedBranch);
    setShowRepoPicker(false);

    // Publish setup only after the owned conversation exists.
    const sessionName = `New Task`;
    await createSession(sessionName, selectedRepo.full_name, undefined, selection.workspaceId);
    clearSetupSessionState();
  };

  const isSessionContextLoading = isSessionContextPending({
    isAuthenticated,
    isAuthLoading: isLoading,
    sessionHydrationStatus,
  });
  const isShellContextLoading =
    isLoading ||
    isSessionContextLoading ||
    (workspaceSelectionBootstrapStatus === "loading" && !hasRealSession);

  // Show loading state while auth, session, or workspace context is settling.
  if (isShellContextLoading) {
    return <ClientShellLoading label="Checking session" />;
  }

  if (!isAuthenticated) {
    return <GitHubSignInPage onLogin={login} />;
  }

  if (!hasRepoContext) {
    return <AuthorizedRepositoryPicker onRepoSelect={handleRepoSelect} />;
  }

  return (
    <ClientShell environment={environment.status === "ready" ? undefined : environment}>
      <WorkspaceFrame
        sidebar={
          <div className="flex h-full">
            <AgentSidebar
              sessions={sessions}
              repositories={repositories}
              activeSessionId={activeSessionId}
              hydrationStatus={sessionHydrationStatus}
              onSelect={handleSelectSession}
              onCreate={handleNewTask}
              onPin={pinSession}
              onUnpin={unpinSession}
              onArchive={async (sessionId) => {
                if (await archiveSession(sessionId)) {
                  retireSessionInitialPrompt(sessionId);
                }
              }}
              onUnarchive={unarchiveSession}
              onRenameSession={handleRenameSession}
              onRemoveRepository={removeRepository}
              onRenameRepository={renameRepository}
              pullRequestsBySessionId={pullRequestsBySessionId}
              onVisibleSelectionChange={handleVisibleSessionChange}
              onPreviewSelectionChange={handlePreviewSessionChange}
              onClose={() => {
                setIsSidebarOpen(false);
              }}
              onAddRepository={() => {
                if (isCompact) setIsSidebarOpen(false);
                handleOpenRepositoryPicker();
              }}
              onOpenSettings={() => {
                if (isCompact) setIsSidebarOpen(false);
                openSettingsDialog("general");
              }}
              accountUser={user}
              onLogout={logout}
              width={isCompact ? Math.min(sidebarWidth, 360) : sidebarWidth}
            />
            {!isCompact ? (
              <Resizer
                side="left"
                onResize={(delta) =>
                  setSidebarWidth((prev) =>
                    Math.max(160, Math.min(520, prev + delta)),
                  )
                }
              />
            ) : null}
          </div>
        }
        topBar={
          <>
            {activeSession?.persistenceStatus === "failed" ? (
              <div
                role="alert"
                data-testid="session-persistence-state"
                className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-100"
              >
                <span>
                  This conversation is an unsaved draft. It remains available in
                  this tab.
                </span>
                <button
                  type="button"
                  className="rounded-md border border-amber-200/30 px-3 py-1 font-medium hover:bg-amber-500/15"
                  onClick={() => void retrySessionPersistence(activeSession.id)}
                >
                  Retry save
                </button>
              </div>
            ) : null}
            <TopNavBar
              onReview={activeSession ? handleOpenReviewSidebar : undefined}
              isRightSidebarOpen={Boolean(activeSession) && isRightSidebarOpen}
              onToggleRightSidebar={handleToggleRightSidebar}
              threadTitle={threadTitle}
              taskTitle={taskTitle}
              activeSession={activeSession}
              onRenameSession={handleRenameSession}
              onPinSession={handlePinActiveSession}
              onUnpinSession={handleUnpinActiveSession}
              onArchiveSession={handleArchiveActiveSession}
              isAuthenticated={isAuthenticated}
              onConnectGitHub={login}
              environmentSummary={environmentSummary}
              isMobile={isMobile}
            />
          </>
        }
        sidebarOpen={isSidebarOpen}
        onSidebarOpenChange={setIsSidebarOpen}
      >

        {/* Main Workspace Layer */}
        <div className="flex-1 flex overflow-hidden relative bg-black">
          <AnimatePresence initial={false} mode="wait">
            {activeSessionId && activeSession ? (
              <SessionConversationSurface
                key={activeSessionId}
                sessionId={activeSessionId}
                runId={activeSession.activeRunId ?? activeSession.latestRunId ?? ""}
                mode={activeSession.mode}
                workspaceContext={sessionWorkspaceContext?.sessionId === activeSession.id ? sessionWorkspaceContext : null}
                isSessionPersistenceReady={isSessionPersistenceReady(
                  activeSession.persistenceStatus,
                )}
                hasQueuedIntent={Boolean(
                  initialPromptSubmissions[activeSessionId],
                )}
                onServerProjectionAvailable={() =>
                  void refreshSessionProjection(activeSessionId)
                }
                onSavedSourcesChange={handleSavedSourcesChange}
                onRunIdChange={(runId) => {
                  if (!activeSession) return;
                  updateSession(activeSessionId, {
                    activeRunId: runId,
                    runIds: Array.from(
                      new Set([...activeSession.runIds, runId]),
                    ),
                  });
                }}
              >
                {({
                  chat,
                  productMode,
                  setProductMode,
                  savedSources,
                  showWorkspace,
                  registerFileCreatedRefresh,
                }) =>
                  showWorkspace ? (
                    <motion.div
                      key={`conversation-${activeSessionId}`}
                      initial={false}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 1 }}
                      transition={{ duration: 0 }}
                      className="absolute inset-0 flex"
                    >
                      <Workspace
                        sessionId={activeSessionId}
                        chat={chat}
                        productMode={productMode}
                        setProductMode={setProductMode}
                        registerFileCreatedRefresh={registerFileCreatedRefresh}
                        sessionTitle={activeSession.name}
                        sessionCreatedAt={activeSession.createdAt}
                        sessionUpdatedAt={activeSession.updatedAt}
                        repository={activeSession.repository || ""}
                        mode={activeSession.mode}
                        isSessionRunning={activeSession.status === "running"}
                        hasStartedSession
                        isWorkspaceContextReady={Boolean(
                          isWorkspaceContextResolved &&
                          activeSessionId === activeSession.id,
                        )}
                        sessionPersistenceStatus={
                          activeSession.persistenceStatus
                        }
                        onModeChange={(mode) =>
                          updateSession(activeSessionId, { mode })
                        }
                        onSessionStatusChange={(status) => {
                          updateSession(
                            activeSessionId,
                            { status },
                            { preserveActivityTimestamp: true },
                          );
                          if (status === "completed" || status === "failed") {
                            void refreshSessionProjection(activeSessionId);
                          }
                        }}
                        initialPromptSubmission={
                          initialPromptSubmissions[activeSessionId] ?? null
                        }
                        onInitialPromptClaim={(id) =>
                          claimInitialPrompt(activeSessionId, id)
                        }
                        onInitialPromptStatusChange={(id, status) =>
                          updateInitialPromptStatus(activeSessionId, id, status)
                        }
                        onInitialPromptRetry={(id) =>
                          retryInitialPrompt(activeSessionId, id)
                        }
                        onInitialPromptHandled={(id) =>
                          settleInitialPrompt(activeSessionId, id)
                        }
                        onPromptSubmitted={(prompt) => {
                          if (prompt.trim())
                            updateSession(activeSessionId, {
                              status: "running",
                            });
                        }}
                        onHookSettingsContextChange={
                          handleHookSettingsContextChange
                        }
                        isRightSidebarOpen={isRightSidebarOpen}
                        setIsRightSidebarOpen={setIsRightSidebarOpen}
                        rightSidebarWidth={rightSidebarWidth}
                        setRightSidebarWidth={setRightSidebarWidth}
                        reviewSidebarFocusRequest={reviewSidebarFocusRequest}
                        isGitReviewOpen={
                          isGitReviewOpen &&
                          gitReviewSessionId === activeSessionId
                        }
                        onGitReviewOpenChange={(open) => {
                          setIsGitReviewOpen(open);
                          setGitReviewSessionId(open ? activeSessionId : null);
                        }}
                        onTabChange={setActiveTab}
                        summaryActionRequest={summaryActionRequest}
                        savedSources={savedSources}
                        environmentSummary={environmentSummary}
                        onOpenRepositoryPicker={handleOpenRepositoryPicker}
                      />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={`setup-${activeSessionId}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="absolute inset-0 flex"
                    >
                      <RunContextProvider
                        runId={activeSession.activeRunId}
                        sessionId={activeSession.id}
                      >
                        <AgentSetup
                          sessionId={activeSessionId}
                          mode={activeSession.mode}
                          onModeChange={(mode) =>
                            updateSession(activeSessionId, { mode })
                          }
                          isRightSidebarOpen={isRightSidebarOpen}
                          reviewSidebarFocusRequest={reviewSidebarFocusRequest}
                          onRepoClick={handleOpenRepositoryPicker}
                          projects={repositories.filter(
                            (repository) => repository !== "New Project",
                          )}
                          onProjectSelect={handleChooseExistingProject}
                          onBranchSelect={handleExplicitBranchSelect}
                          onNoProject={handleChooseNoProject}
                          onStart={(config) => {
                            updateSession(activeSessionId, {
                              status: "running",
                              mode: config.mode,
                            });
                            const submission: InitialPromptSubmission = {
                              id: createInitialPromptSubmissionId(
                                crypto.randomUUID(),
                              ),
                              prompt: config.task,
                              attachments: config.attachments,
                              status: "queued",
                            };
                            const previous =
                              initialPromptSubmissionsRef.current[
                                activeSessionId
                              ];
                            if (previous) {
                              retireSubmissionIntent(
                                activeSessionId,
                                `client_msg_${previous.id}`,
                              );
                            }
                            updateInitialPromptSubmissions((current) => ({
                              ...current,
                              [activeSessionId]: submission,
                            }));
                          }}
                        />
                      </RunContextProvider>
                    </motion.div>
                  )
                }
              </SessionConversationSurface>
            ) : showShellSetupSurface && setupSession ? (
              <motion.div
                key={`setup-shell-${setupSession.id}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0 flex"
              >
                <RunContextProvider
                  runId={setupSession.activeRunId}
                  sessionId={setupSession.id}
                >
                  <AgentSetup
                    sessionId={setupSession.id}
                    isRightSidebarOpen={isRightSidebarOpen}
                    reviewSidebarFocusRequest={reviewSidebarFocusRequest}
                    requiresRepository
                    onRepoClick={handleOpenRepositoryPicker}
                    projects={repositories.filter(
                      (repository) => repository !== "New Project",
                    )}
                    onProjectSelect={handleChooseExistingProject}
                    onNoProject={handleChooseNoProject}
                    onStart={() => {
                      handleOpenRepositoryPicker();
                    }}
                  />
                </RunContextProvider>
              </motion.div>
            ) : isPreparingSetupShell ? (
              <motion.div
                key="preparing-setup-shell"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-500 text-sm"
              >
                <div className="animate-spin h-8 w-8 rounded-full border-2 border-zinc-700 border-t-zinc-100" />
                Preparing setup workspace...
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex-1 flex items-center justify-center text-zinc-600 italic text-sm"
              >
                Select or create a task to get started
              </motion.div>
            )}
          </AnimatePresence>

          {showRepoPicker && isAuthenticated ? (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 backdrop-blur-sm">
              <AuthorizedRepositoryPicker
                onRepoSelect={handleRepoSelect}
                onClose={() => setShowRepoPicker(false)}
              />
            </div>
          ) : null}

          <SettingsDialog
            isOpen={isSettingsDialogOpen}
            runId={
              isAuthenticated
                ? (activeSessionId ?? providerScopeRunId)
                : undefined
            }
            workspaceId={
              hookSettingsContext?.sessionId === activeSessionId
                ? hookSettingsContext.workspaceId
                : null
            }
            hookAudits={
              hookSettingsContext?.sessionId === activeSessionId
                ? hookSettingsContext.audits
                : []
            }
            initialSection={settingsInitialSection}
            onUnarchiveSession={unarchiveSession}
            onClose={() => setIsSettingsDialogOpen(false)}
          />
        </div>
      </WorkspaceFrame>
    </ClientShell>
  );
}

export default App;
