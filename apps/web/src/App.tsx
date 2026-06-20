import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useSessionManager } from "./hooks/useSessionManager";
import { AgentSidebar } from "./components/layout/AgentSidebar";
import { Workspace } from "./components/layout/Workspace";
import { TabType } from "./components/layout/workspace/useWorkspaceState";
import { AgentSetup } from "./components/agent/AgentSetup";
import { TopNavBar } from "./components/layout/TopNavBar";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import {
  GitHubContextProvider,
  useGitHub,
} from "./components/github/GitHubContextProvider";
import { RepoPicker } from "./components/github/RepoPicker";
import type {
  Repository,
  WorkspaceListItem,
  WorkspaceListResponse,
  WorkspaceRepositoryRecord,
} from "./services/GitHubService";
import * as GitHubService from "./services/GitHubService";
import { Resizer } from "./components/ui/Resizer";
import { uiShellStore } from "./store/uiShellStore";
import type { RunInboxItem } from "./components/run/RunInbox";
import { SessionStateService } from "./services/SessionStateService";
import { RunContextProvider } from "./hooks/useRunContext";
import { useProviderStore } from "./hooks/useProviderStore";
import { usePendingApprovalStateBySession } from "./hooks/usePendingApprovalStateBySession";
import {
  isSessionContextPending,
  resolveShellStartupState,
} from "./lib/startup-shell-state";
import { getBrainHttpBase } from "./lib/platform-endpoints";
import { doesSessionContextMatchRepository } from "./lib/repository-context-match";
import { resolveTaskRepositoryFullName } from "./lib/session-github-context";
import { LockedShellCard } from "./components/startup/LockedShellCard";
import { AuthShellLoading } from "./components/startup/AuthShellLoading";
import type { SetupSessionState } from "./types/session";
import { StartupOnboardingOverlay } from "./components/onboarding/StartupOnboardingOverlay";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { generateChatTitleFromPrompt } from "./lib/chat-title-generator";
import {
  subscribeToOpenSettingsDialog,
  type SettingsSection,
} from "./lib/settings-dialog-events";
import {
  isApprovalRequiredRunStatus,
  isTerminalRunStatus,
  mapRunStatusToSessionStatus,
} from "./lib/run-status";
import {
  parseRunSummaryStatusSnapshot,
  type RunSummaryStatusSnapshot,
} from "./lib/run-summary-status-snapshot";

function buildOnboardingSeenKey(userId: string | null): string {
  if (!userId) {
    return "shadowbox:startup-onboarding:seen:anonymous";
  }
  return `shadowbox:startup-onboarding:seen:${userId}`;
}

const RUN_STATUS_RECONCILE_INTERVAL_MS = 12_000;

async function fetchRunSummaryStatus(
  runId: string,
): Promise<RunSummaryStatusSnapshot | null> {
  const response = await fetch(
    `${getBrainHttpBase()}/api/run/summary?runId=${encodeURIComponent(runId)}`,
    { credentials: "include" },
  );
  if (!response.ok) {
    return null;
  }
  return parseRunSummaryStatusSnapshot(await response.json());
}

function buildRepositoryFromWorkspace(
  repository: WorkspaceRepositoryRecord,
  selectedBranch: string,
): Repository {
  return {
    id: Number(repository.providerRepoId ?? 0),
    name: repository.name,
    full_name: repository.fullName,
    owner: {
      login: repository.owner,
      avatar_url: "",
    },
    description: null,
    private: false,
    html_url: repository.repoUrl,
    clone_url: `${repository.repoUrl}.git`,
    default_branch: selectedBranch || repository.defaultBranch,
    stargazers_count: 0,
    language: null,
    updated_at: repository.updatedAt,
  };
}

function findWorkspaceForRepository(
  repository: string | null,
  workspaceState: WorkspaceListResponse,
): { repository: WorkspaceRepositoryRecord; branch: string } | null {
  const expectedRepository = repository?.trim();
  if (!expectedRepository) {
    return null;
  }

  if (
    workspaceState.selection &&
    doesSessionContextMatchRepository(expectedRepository, {
      fullName: workspaceState.selection.repository.fullName,
      repoName: workspaceState.selection.repository.name,
    })
  ) {
    return {
      repository: workspaceState.selection.repository,
      branch: workspaceState.selection.selectedBranch,
    };
  }

  const workspace = workspaceState.workspaces.find((item: WorkspaceListItem) =>
    doesSessionContextMatchRepository(expectedRepository, {
      fullName: item.repository.fullName,
      repoName: item.repository.name,
    }),
  );
  if (!workspace) {
    return null;
  }

  return {
    repository: workspace.repository,
    branch:
      workspace.workspace.lastSelectedBranch ||
      workspace.workspace.defaultBranch ||
      workspace.repository.defaultBranch,
  };
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
  const { isAuthenticated, isLoading, login, refreshSession, user } = useAuth();
  const {
    sessions,
    activeSessionId,
    sessionHydrationStatus,
    setActiveSessionId,
    createSession,
    removeSession,
    renameSession,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    updateSession,
    repositories,
    removeRepository,
    renameRepository,
  } = useSessionManager({
    hydrateFromServer: isAuthenticated && !isLoading,
  });
  const {
    repo,
    branch,
    switchBranch,
    setContext,
    clearContext,
    saveSessionContext,
  } = useGitHub();
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [isGitReviewOpen, setIsGitReviewOpen] = useState(false);
  const [gitReviewSessionId, setGitReviewSessionId] = useState<string | null>(
    null,
  );
  const { approvalStatesBySessionId, handlePendingApprovalStateChange } =
    usePendingApprovalStateBySession();
  const [reviewSidebarFocusRequest, setReviewSidebarFocusRequest] = useState(0);
  const [summaryActionRequest, setSummaryActionRequest] = useState<{
    id: number;
    action: "changes" | "commit";
  } | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    try {
      const stored = localStorage.getItem("shadowbox_active_tab");
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
  const [isOnboardingOverlayDelayElapsed, setIsOnboardingOverlayDelayElapsed] =
    useState(false);
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState<boolean>(() => {
    try {
      const key = buildOnboardingSeenKey(user?.id ?? null);
      return localStorage.getItem(key) === "true";
    } catch (error) {
      console.warn("[App] Failed to read onboarding seen state:", error);
      return false;
    }
  });
  const [isOnboardingReopened, setIsOnboardingReopened] =
    useState<boolean>(false);
  const [isWorkspaceContextRepairing, setIsWorkspaceContextRepairing] =
    useState(false);
  const workspaceContextRepairGenerationRef = useRef(0);
  const scheduleWorkspaceContextRepairState = useCallback(
    (nextValue: boolean): void => {
      const generation = workspaceContextRepairGenerationRef.current + 1;
      workspaceContextRepairGenerationRef.current = generation;

      window.setTimeout(() => {
        if (workspaceContextRepairGenerationRef.current !== generation) {
          return;
        }
        setIsWorkspaceContextRepairing(nextValue);
      }, 0);
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    try {
      const key = buildOnboardingSeenKey(user?.id ?? null);
      const nextValue = localStorage.getItem(key) === "true";
      window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        setHasSeenOnboarding(nextValue);
      }, 0);
    } catch (error) {
      console.warn("[App] Failed to hydrate onboarding seen state:", error);
      window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        setHasSeenOnboarding(false);
      }, 0);
    }
    return () => {
      cancelled = true;
    };
  }, [user?.id]);
  const persistOnboardingSeen = useCallback(() => {
    try {
      const key = buildOnboardingSeenKey(user?.id ?? null);
      localStorage.setItem(key, "true");
    } catch (error) {
      console.warn("[App] Failed to persist onboarding seen state:", error);
    }
  }, [user]);
  const lastSyncedGitHubSessionIdRef = useRef<string | null>(null);

  const openSettingsDialog = useCallback(
    (section: SettingsSection = "general") => {
      setSettingsInitialSection(section);
      setIsSettingsDialogOpen(true);
    },
    [],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
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
    providerScopeSession?.activeRunId ?? setupSession?.activeRunId;
  const {
    bootstrap: bootstrapProviderStore,
    credentials,
    reset: resetProviderStore,
  } = useProviderStore(isAuthenticated ? providerScopeRunId : undefined);

  // Convert sessions to run inbox items for shell navigation
  // This supports the run-centric UI model and will be passed to AppShell in future PRs
  // TODO: Use this in AppShell integration (PR 04)
  // @ts-expect-error - intentionally unused, will be used in next PR
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const convertSessionsToRuns = (): RunInboxItem[] => {
    return sessions.map((session) => {
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

      return {
        runId: session.activeRunId,
        sessionId: session.id,
        title: session.name,
        status,
        updatedAt,
        repository: session.repository ?? "No repository",
      };
    });
  };

  // Sync UI shell store with active session
  useEffect(() => {
    if (!activeSessionId) return;

    const storeState = uiShellStore.getState();

    // Only sync if the active session actually changed
    if (storeState.activeSessionId === activeSessionId) {
      return;
    }

    uiShellStore.setActiveSessionId(activeSessionId);

    // Find active session's runId and sync it
    // Note: This lookup is safe because we've already validated activeSessionId exists
    if (activeSession) {
      uiShellStore.setActiveRunId(activeSession.activeRunId);
    }
  }, [activeSessionId, activeSession]);

  // Sync GitHub context with active session
  // Uses SessionStateService for session-scoped storage
  useEffect(() => {
    if (!activeSessionId || !activeSession) {
      scheduleWorkspaceContextRepairState(false);
      return;
    }
    const sessionChanged =
      lastSyncedGitHubSessionIdRef.current !== activeSessionId;
    lastSyncedGitHubSessionIdRef.current = activeSessionId;

    const sessionContext =
      SessionStateService.loadSessionGitHubContext(activeSessionId);

    if (sessionContext) {
      if (
        !doesSessionContextMatchRepository(activeSession.repository, {
          fullName: sessionContext.fullName,
          repoName: sessionContext.repoName,
        })
      ) {
        console.warn(
          `[App] Invalid session context for ${activeSessionId}. Expected ${activeSession.repository}, found ${sessionContext.fullName}. Clearing stale context.`,
        );
        SessionStateService.clearSessionGitHubContext(activeSessionId);
        if (repo) {
          clearContext();
        }
        return;
      }

      scheduleWorkspaceContextRepairState(false);
      // Reconstruct Repository object from stored context
      // Only include fields actually needed; others should be loaded on demand
      const storedRepo: Repository = {
        id: 0,
        name: sessionContext.repoName,
        full_name: sessionContext.fullName,
        owner: {
          login: sessionContext.repoOwner,
          avatar_url: "", // Not stored; can be fetched from GitHub API if needed
        },
        description: null,
        private: false,
        html_url: `https://github.com/${sessionContext.fullName}`,
        clone_url: `https://github.com/${sessionContext.fullName}.git`,
        default_branch: sessionContext.branch,
        stargazers_count: 0,
        language: null,
        updated_at: new Date().toISOString(),
      };

      const hasCurrentBranch = branch.trim().length > 0;
      const shouldHydrateFromSession =
        sessionChanged ||
        repo?.full_name !== sessionContext.fullName ||
        !hasCurrentBranch;

      if (shouldHydrateFromSession) {
        setContext(storedRepo, sessionContext.branch);
      } else if (branch !== sessionContext.branch) {
        SessionStateService.saveSessionGitHubContext(activeSessionId, {
          ...sessionContext,
          branch,
        });
      }
    } else {
      const activeRepository = activeSession.repository?.trim() ?? "";

      if (
        repo &&
        doesSessionContextMatchRepository(activeRepository, {
          fullName: repo.full_name,
          repoName: repo.name,
        })
      ) {
        scheduleWorkspaceContextRepairState(false);
        const repairedBranch = branch.trim() || repo.default_branch || "main";
        SessionStateService.saveSessionGitHubContext(activeSessionId, {
          repoOwner: repo.owner.login,
          repoName: repo.name,
          fullName: repo.full_name,
          branch: repairedBranch,
        });
        if (!branch.trim()) {
          setContext(repo, repairedBranch);
        }
        return;
      }

      if (!activeRepository || activeRepository === "New Project") {
        scheduleWorkspaceContextRepairState(false);
        if (repo) {
          clearContext();
        }
        return;
      }

      let cancelled = false;
      scheduleWorkspaceContextRepairState(true);

      const repairSessionContextFromWorkspace = async (): Promise<void> => {
        try {
          const workspaceState = await GitHubService.listWorkspaces();
          if (cancelled) {
            return;
          }

          const workspaceContext = findWorkspaceForRepository(
            activeRepository,
            workspaceState,
          );
          if (!workspaceContext) {
            scheduleWorkspaceContextRepairState(false);
            if (repo) {
              clearContext();
            }
            return;
          }

          const repairedRepo = buildRepositoryFromWorkspace(
            workspaceContext.repository,
            workspaceContext.branch,
          );
          SessionStateService.saveSessionGitHubContext(activeSessionId, {
            repoOwner: repairedRepo.owner.login,
            repoName: repairedRepo.name,
            fullName: repairedRepo.full_name,
            branch: workspaceContext.branch,
          });
          setContext(repairedRepo, workspaceContext.branch);
          scheduleWorkspaceContextRepairState(false);
        } catch (error) {
          console.warn(
            "[App] Failed to repair session GitHub context from workspace state:",
            error,
          );
          if (!cancelled && repo) {
            clearContext();
          }
          if (!cancelled) {
            scheduleWorkspaceContextRepairState(false);
          }
        }
      };

      void repairSessionContextFromWorkspace();

      return () => {
        cancelled = true;
      };
    }
  }, [
    activeSessionId,
    activeSession,
    repo,
    branch,
    setContext,
    clearContext,
    scheduleWorkspaceContextRepairState,
  ]);

  const lastPersistedWorkspaceSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    const selectedBranch = branch.trim();
    if (
      isLoading ||
      !isAuthenticated ||
      !user ||
      !repo ||
      selectedBranch.length === 0
    ) {
      return;
    }

    const selectionKey = `${user.id}:${repo.full_name}:${selectedBranch}`;
    if (lastPersistedWorkspaceSelectionRef.current === selectionKey) {
      return;
    }

    let cancelled = false;
    lastPersistedWorkspaceSelectionRef.current = selectionKey;

    const persistActiveWorkspaceSelection = async (): Promise<void> => {
      try {
        await GitHubService.selectWorkspace(repo, selectedBranch);
        if (cancelled) {
          return;
        }
        await refreshSession();
        if (cancelled || !providerScopeRunId) {
          return;
        }
        await bootstrapProviderStore();
      } catch (error) {
        if (cancelled) {
          return;
        }
        lastPersistedWorkspaceSelectionRef.current = null;
        console.error(
          "[workspace/select] Failed to reconcile selection:",
          error,
        );
        window.dispatchEvent(
          new CustomEvent("legioncode:workspace-selection-persist-failed", {
            detail: {
              repository: repo.full_name,
              branch: selectedBranch,
            },
          }),
        );
      }
    };

    void persistActiveWorkspaceSelection();

    return () => {
      cancelled = true;
    };
  }, [
    bootstrapProviderStore,
    branch,
    isAuthenticated,
    isLoading,
    providerScopeRunId,
    refreshSession,
    repo,
    user,
  ]);

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
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(() => {
    return localStorage.getItem("shadowbox_right_sidebar_open") === "true";
  });
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(520);

  const scopedApprovalStatesBySessionId = useMemo(() => {
    const validSessionIds = new Set(sessions.map((session) => session.id));
    const nextEntries = Object.entries(approvalStatesBySessionId).filter(
      ([sessionId]) => validSessionIds.has(sessionId),
    );
    return Object.fromEntries(nextEntries);
  }, [approvalStatesBySessionId, sessions]);
  const reconcilableSessions = useMemo(
    () =>
      sessions.filter((session) =>
        ["running", "waiting_for_approval", "paused"].includes(session.status),
      ),
    [sessions],
  );

  useEffect(() => {
    if (!isAuthenticated || reconcilableSessions.length === 0) {
      return;
    }

    let cancelled = false;
    const reconcile = async (): Promise<void> => {
      const updates = await Promise.all(
        reconcilableSessions.map(async (session) => {
          try {
            const snapshot = await fetchRunSummaryStatus(session.activeRunId);
            if (!snapshot) {
              return null;
            }
            if (
              !snapshot.hasPendingApproval &&
              !isApprovalRequiredRunStatus(snapshot.status) &&
              !isTerminalRunStatus(snapshot.status)
            ) {
              return null;
            }

            return {
              sessionId: session.id,
              status: mapRunStatusToSessionStatus(snapshot.status, {
                hasPendingApproval: snapshot.hasPendingApproval,
              }),
              hasPendingApproval: snapshot.hasPendingApproval,
            };
          } catch (error) {
            console.warn(
              `[App] Failed to reconcile run status for session ${session.id}`,
              error,
            );
            return null;
          }
        }),
      );

      if (cancelled) {
        return;
      }

      updates.forEach((update) => {
        if (!update) {
          return;
        }
        if (update.status) {
          updateSession(update.sessionId, { status: update.status });
        }
        handlePendingApprovalStateChange(
          update.sessionId,
          update.hasPendingApproval,
        );
      });
    };

    void reconcile();
    const intervalId = window.setInterval(() => {
      void reconcile();
    }, RUN_STATUS_RECONCILE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    handlePendingApprovalStateChange,
    isAuthenticated,
    reconcilableSessions,
    updateSession,
  ]);

  useEffect(() => {
    localStorage.setItem(
      "shadowbox_right_sidebar_open",
      String(isRightSidebarOpen),
    );
  }, [isRightSidebarOpen]);

  useEffect(() => {
    localStorage.setItem("shadowbox_active_tab", activeTab);
  }, [activeTab]);

  // Check if current session has a pending query or messages
  const hasPendingQuery = activeSessionId
    ? !!SessionStateService.loadSessionPendingQuery(activeSessionId)
    : false;

  // A session is considered to have "started" if:
  // 1. It has a pending query in session-scoped storage
  // 2. OR its name has been changed from "New Task"
  // 3. OR its status is not "idle"
  const isSessionStarted =
    !!activeSession &&
    (hasPendingQuery ||
      (activeSession.name !== "New Task" && activeSession.name !== "") ||
      (activeSession.status && activeSession.status !== "idle"));

  // Robust visibility flags
  const showSetup =
    isAuthenticated &&
    !!activeSessionId &&
    !!activeSession &&
    !isSessionStarted;
  const showWorkspace =
    isAuthenticated &&
    !!activeSessionId &&
    !!activeSession &&
    !!isSessionStarted;
  const hasProviderConnection = isAuthenticated && credentials.length > 0;
  const hasRealSession = sessions.length > 0;
  const hasRepoContext = sessions.some(
    (session) => (session.repository?.trim() ?? "").length > 0,
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
  const isStartupSetupVisible =
    showSetup || (showShellSetupSurface && setupSession !== null);
  const isOnboardingComplete = hasProviderConnection && hasRepoContext;
  const shouldOfferOnboardingOverlay =
    isAuthenticated && isStartupSetupVisible && !isOnboardingComplete;
  const showOnboardingOverlay =
    shouldOfferOnboardingOverlay &&
    !isPreparingSetupShell &&
    ((isOnboardingReopened && isOnboardingOverlayDelayElapsed) ||
      (!hasSeenOnboarding && isOnboardingOverlayDelayElapsed));
  const showOnboardingReopenButton =
    shouldOfferOnboardingOverlay &&
    hasSeenOnboarding &&
    !showOnboardingOverlay &&
    !isPreparingSetupShell;
  const onboardingWasShownRef = useRef(false);
  useEffect(() => {
    onboardingWasShownRef.current = false;
  }, [user?.id]);

  useEffect(() => {
    if (!shouldOfferOnboardingOverlay) {
      onboardingWasShownRef.current = false;
      window.setTimeout(() => {
        setIsOnboardingReopened(false);
      }, 0);
    }
  }, [shouldOfferOnboardingOverlay]);

  useEffect(() => {
    if (!showOnboardingOverlay || onboardingWasShownRef.current) {
      return;
    }
    onboardingWasShownRef.current = true;
    if (!hasSeenOnboarding) {
      persistOnboardingSeen();
    }
  }, [hasSeenOnboarding, persistOnboardingSeen, showOnboardingOverlay]);

  useEffect(() => {
    if (!shouldOfferOnboardingOverlay) {
      return;
    }

    if (isOnboardingOverlayDelayElapsed) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsOnboardingOverlayDelayElapsed(true);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isOnboardingOverlayDelayElapsed, shouldOfferOnboardingOverlay]);

  // Get active session name for the header
  const taskTitle = activeSession?.name;
  const threadTitle = activeSession?.name;

  const handleRenameActiveSession = useCallback(
    async (title: string): Promise<void> => {
      if (!activeSessionId) {
        return;
      }
      await renameSession(activeSessionId, title);
    },
    [activeSessionId, renameSession],
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
      await archiveSession(activeSessionId);
    }
  }, [activeSessionId, archiveSession]);

  const handleOpenRepositoryPicker = () => {
    if (!isAuthenticated) {
      login();
      return;
    }

    setShowRepoPicker(true);
  };

  const handleOpenProviderSetup = () => {
    openSettingsDialog("connect");
  };

  useEffect(() => {
    return subscribeToOpenSettingsDialog((section) => {
      openSettingsDialog(section);
    });
  }, [openSettingsDialog]);

  const handleDismissOnboardingOverlay = () => {
    setIsOnboardingOverlayDelayElapsed(false);
    setIsOnboardingReopened(false);
    setHasSeenOnboarding(true);
    persistOnboardingSeen();
  };

  const handleReopenOnboardingOverlay = () => {
    setIsOnboardingReopened(true);
    setIsOnboardingOverlayDelayElapsed(true);
    onboardingWasShownRef.current = true;
  };
  const handleNewTask = (repositoryName?: string) => {
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
      clearSetupSessionState();
      // Create a session for this specific repository
      const sessionName = `New Task`;
      const sessionId = createSession(sessionName, targetRepo);

      // Clear pending query for new task
      SessionStateService.clearSessionPendingQuery(sessionId);

      // Sync GitHub context with new session
      // Use SessionStateService for session-scoped storage
      const otherSessionWithRepo = sessions.find(
        (s) => s.repository === targetRepo,
      );

      if (otherSessionWithRepo) {
        const sessionContext = SessionStateService.loadSessionGitHubContext(
          otherSessionWithRepo.id,
        );
        if (sessionContext) {
          SessionStateService.saveSessionGitHubContext(
            sessionId,
            sessionContext,
          );
        }
      } else if (repo && repo.full_name === targetRepo) {
        // Copy current GitHub context to new session
        saveSessionContext(sessionId);
      }
    } else {
      // If absolutely no repo is selected, targetRepo is missing,
      // or the user has deleted the repo folder
      handleOpenRepositoryPicker();
    }
  };

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

  const handleToggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  const handleSelectSession = (sessionId: string) => {
    if (sessionId !== activeSessionId) {
      setIsGitReviewOpen(false);
      setGitReviewSessionId(null);
    }
    setActiveSessionId(sessionId);
  };

  /**
   * Handle repository selection from RepoPicker
   * Creates a session immediately for the selected repository
   */
  const handleRepoSelect = async (
    selectedRepo: Repository,
    selectedBranch: string,
  ): Promise<void> => {
    try {
      await GitHubService.selectWorkspace(selectedRepo, selectedBranch);
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
      return;
    }

    setIsGitReviewOpen(false);
    setGitReviewSessionId(null);
    setContext(selectedRepo, selectedBranch);
    setShowRepoPicker(false);
    clearSetupSessionState();

    // Create a session immediately for this repository so it shows in sidebar
    const sessionName = `New Task`;
    const sessionId = createSession(sessionName, selectedRepo.full_name);

    // Store GitHub context for the session using SessionStateService
    SessionStateService.saveSessionGitHubContext(sessionId, {
      repoOwner: selectedRepo.owner.login,
      repoName: selectedRepo.name,
      fullName: selectedRepo.full_name,
      branch: selectedBranch,
    });
  };

  /**
   * Handle skip - allow user to proceed without GitHub
   */
  const handleSkipRepoPicker = () => {
    setShowRepoPicker(false);
  };

  const isSessionContextLoading = isSessionContextPending({
    isAuthenticated,
    isAuthLoading: isLoading,
    sessionHydrationStatus,
  });
  const isShellContextLoading =
    isLoading || isSessionContextLoading || isWorkspaceContextRepairing;

  // Show loading state while auth, session, or workspace context is settling.
  if (isShellContextLoading) {
    return <AuthShellLoading />;
  }

  return (
    <div className="h-screen w-screen bg-background text-zinc-400 flex overflow-hidden font-sans">
      {/* Sidebar - Independent */}
      {isSidebarOpen && (
        <div className="relative flex shrink-0" style={{ width: sidebarWidth }}>
          <AgentSidebar
            sessions={sessions}
            repositories={repositories}
            activeSessionId={activeSessionId}
            approvalStatesBySessionId={scopedApprovalStatesBySessionId}
            onSelect={handleSelectSession}
            onCreate={handleNewTask}
            onRemove={removeSession}
            onRemoveRepository={removeRepository}
            onRenameRepository={renameRepository}
            onClose={handleToggleSidebar}
            onAddRepository={handleOpenRepositoryPicker}
            onOpenSettings={() => openSettingsDialog("general")}
            width={sidebarWidth}
          />
          <Resizer
            side="left"
            onResize={(delta) =>
              setSidebarWidth((prev) =>
                Math.max(160, Math.min(520, prev + delta)),
              )
            }
          />
        </div>
      )}

      {/* Main Content Area with Top NavBar */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top Navigation Bar - Only in content area */}
        <TopNavBar
          onReview={showWorkspace ? handleOpenReviewSidebar : undefined}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={handleToggleSidebar}
          isRightSidebarOpen={showWorkspace && isRightSidebarOpen}
          rightSidebarWidth={rightSidebarWidth}
          onToggleRightSidebar={handleToggleRightSidebar}
          threadTitle={threadTitle}
          taskTitle={taskTitle}
          activeSession={activeSession}
          onRenameSession={handleRenameActiveSession}
          onPinSession={handlePinActiveSession}
          onUnpinSession={handleUnpinActiveSession}
          onArchiveSession={handleArchiveActiveSession}
          isAuthenticated={isAuthenticated}
          onConnectGitHub={login}
          environmentSummary={
            showWorkspace && activeSessionId && activeSession
              ? {
                  sessionId: activeSessionId,
                  runId: activeSession.activeRunId,
                  repo,
                  branch,
                  onBranchChange: switchBranch,
                  onOpenChanges: () =>
                    setSummaryActionRequest({
                      id: Date.now(),
                      action: "changes",
                    }),
                  onOpenCommit: () =>
                    setSummaryActionRequest({
                      id: Date.now(),
                      action: "commit",
                    }),
                }
              : undefined
          }
        />

        {/* Main Workspace Layer */}
        <div className="flex-1 flex overflow-hidden relative bg-black">
          <AnimatePresence initial={false} mode="wait">
            {shellStartupState === "shell_locked_unauthenticated" ? (
              <motion.div
                key="locked-shell"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0"
              >
                <LockedShellCard onLogin={login} />
              </motion.div>
            ) : showSetup ? (
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
                    showOnboardingHighlights={showOnboardingOverlay}
                    onRepoClick={handleOpenRepositoryPicker}
                    onStart={(config) => {
                      const name = generateChatTitleFromPrompt(config.task);

                      updateSession(activeSessionId, {
                        name,
                        titleSource: "generated",
                        status: "running",
                        mode: config.mode,
                      });
                      void SessionStateService.updateGeneratedSessionTitle(
                        activeSessionId,
                        name,
                      ).catch((error) => {
                        console.warn(
                          "[App] Failed to persist generated title:",
                          error,
                        );
                      });
                      // Store pending query in session-scoped storage
                      SessionStateService.saveSessionPendingQuery(
                        activeSessionId,
                        config.task,
                      );
                      // State updates above (updateSession + saveSessionPendingQuery)
                      // will naturally trigger re-renders; no manual trigger needed
                    }}
                  />
                </RunContextProvider>
              </motion.div>
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
                    showOnboardingHighlights={showOnboardingOverlay}
                    onRepoClick={handleOpenRepositoryPicker}
                    onStart={() => {
                      handleOpenRepositoryPicker();
                    }}
                  />
                </RunContextProvider>
              </motion.div>
            ) : showWorkspace ? (
              <motion.div
                key="workspace"
                initial={false}
                animate={{ opacity: 1 }}
                exit={{ opacity: 1 }}
                transition={{ duration: 0 }}
                className="absolute inset-0 flex"
              >
                <Workspace
                  sessionId={activeSessionId}
                  runId={activeSession?.activeRunId || ""}
                  repository={activeSession?.repository || ""}
                  mode={activeSession?.mode}
                  isSessionRunning={activeSession?.status === "running"}
                  hasStartedSession={isSessionStarted}
                  allowPendingQueryRestore={
                    activeSession?.status !== "completed" &&
                    activeSession?.status !== "paused" &&
                    activeSession?.status !== "failed"
                  }
                  onModeChange={(mode) =>
                    updateSession(activeSessionId, { mode })
                  }
                  onSessionStatusChange={(status) =>
                    updateSession(activeSessionId, { status })
                  }
                  onPromptSubmitted={(prompt) => {
                    if (activeSession?.name !== "New Task") {
                      return;
                    }
                    const name = generateChatTitleFromPrompt(prompt);
                    if (name === "New Task") {
                      return;
                    }
                    updateSession(activeSessionId, {
                      name,
                      titleSource: "generated",
                    });
                    void SessionStateService.updateGeneratedSessionTitle(
                      activeSessionId,
                      name,
                    ).catch((error) => {
                      console.warn(
                        "[App] Failed to persist generated title:",
                        error,
                      );
                    });
                  }}
                  onPendingApprovalStateChange={(hasPendingApproval) => {
                    handlePendingApprovalStateChange(
                      activeSessionId,
                      hasPendingApproval,
                    );
                  }}
                  isRightSidebarOpen={isRightSidebarOpen}
                  setIsRightSidebarOpen={setIsRightSidebarOpen}
                  rightSidebarWidth={rightSidebarWidth}
                  setRightSidebarWidth={setRightSidebarWidth}
                  reviewSidebarFocusRequest={reviewSidebarFocusRequest}
                  isGitReviewOpen={
                    isGitReviewOpen && gitReviewSessionId === activeSessionId
                  }
                  onGitReviewOpenChange={(open) => {
                    setIsGitReviewOpen(open);
                    setGitReviewSessionId(open ? activeSessionId : null);
                  }}
                  onTabChange={setActiveTab}
                  summaryActionRequest={summaryActionRequest}
                />
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

          {showOnboardingOverlay ? (
            <StartupOnboardingOverlay
              isRepositoryStepComplete={hasRepoContext}
              isProviderStepComplete={hasProviderConnection}
              onOpenRepositoryPicker={handleOpenRepositoryPicker}
              onOpenProviderSetup={handleOpenProviderSetup}
              onDismiss={handleDismissOnboardingOverlay}
            />
          ) : null}

          {showOnboardingReopenButton ? (
            <button
              type="button"
              onClick={handleReopenOnboardingOverlay}
              className="absolute bottom-5 right-5 z-20 rounded-full border border-zinc-700 bg-zinc-900/90 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
            >
              Show setup guide
            </button>
          ) : null}

          {showRepoPicker && isAuthenticated ? (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 backdrop-blur-sm">
              <RepoPicker
                onRepoSelect={handleRepoSelect}
                onSkip={handleSkipRepoPicker}
              />
            </div>
          ) : null}

          <SettingsDialog
            isOpen={isSettingsDialogOpen}
            runId={isAuthenticated ? providerScopeRunId : undefined}
            initialSection={settingsInitialSection}
            onUnarchiveSession={unarchiveSession}
            onClose={() => setIsSettingsDialogOpen(false)}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
