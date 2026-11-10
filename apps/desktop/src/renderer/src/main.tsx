import {
  ClientErrorBoundary,
  ClientShell,
  ClientShellLoading,
  getInitialRightSidebarWidth,
  clampRightSidebarWidth,
  EnvironmentSummaryMenu,
  WorkspaceReviewControls,
  WorkspaceFrame,
  WorkspaceSummaryLayout,
  WorkspaceTopBar,
} from "@legioncode/client-ui";
import { AppServerClientError, createAppServerClient } from "@legioncode/sdk";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";
import type { LocalWorkspaceGrant, Thread } from "@repo/platform-protocol";

import type {
  DesktopBuildInfo,
  WorkspaceSelection,
} from "../../shared/desktop-api";
import { DesktopSidebar } from "./DesktopSidebar";
import { useDesktopWorkspacePicker } from "./useDesktopWorkspacePicker";
import { DesktopSettingsDialog } from "./DesktopSettingsDialog";
import { DesktopRightPanel } from "./DesktopRightPanel";
import { DesktopWorkspaceFilesMount } from "./DesktopWorkspaceFilesMount";
import { DesktopConversation } from "./DesktopConversation";
import { DesktopComposer } from "./DesktopComposer";
import { DesktopComposerWorkspaceBar } from "./DesktopComposerWorkspaceBar";
import { useDesktopProjectNavigation, type DesktopProjectIntent } from "./useDesktopProjectNavigation";
import { useDesktopComposerDraft } from "./useDesktopComposerDraft";
import { useDesktopPendingTitleProjectionRefresh } from "./useDesktopPendingTitleProjectionRefresh";
import { DesktopWorkspaceReview } from "./DesktopWorkspaceReview";
import type { DesktopReviewSource } from "./DesktopReviewPresentation";
import { DesktopSavedCommitDialog } from "./DesktopSavedCommitDialog";
import { useDesktopSavedReviewSelection } from "./useDesktopSavedReviewSelection";
import { DesktopWorkspaceBootstrapHero, useDesktopWorkspaceBootstrap } from "./DesktopWorkspaceBootstrap";
import "./styles.css";

type ThreadLoadState = "loading" | "ready" | "error";

function DesktopApp(): React.JSX.Element {
  const selectionRequest = useRef(0);
  const threadScope = useRef(0);
  const threadListRequest = useRef(0);
  const [build, setBuild] = useState<DesktopBuildInfo | null>(null);
  const [environment, setEnvironment] =
    useState<AppServerEnvironmentSnapshot | null>(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadLoadState, setThreadLoadState] =
    useState<ThreadLoadState>("loading");
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<"general" | "connect-only" | "manage-models-only" | null>(null);
  const [providerRevision, setProviderRevision] = useState(0);
  const [commitOpen, setCommitOpen] = useState(false);
  const [reviewSource, setReviewSource] = useState<{ key: string; value: DesktopReviewSource } | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(
    () => window.matchMedia("(min-width: 1280px)").matches,
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(() => getInitialRightSidebarWidth(window.innerWidth));
  const rightPanelToggleRef = useRef<HTMLButtonElement>(null);
  const [changesRequestId, setChangesRequestId] = useState(0);
  const restoreRightPanelFocus = useRef(false);
  useEffect(() => {
    if (rightPanelOpen || !restoreRightPanelFocus.current) return;
    restoreRightPanelFocus.current = false;
    rightPanelToggleRef.current?.focus();
  }, [rightPanelOpen]);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const workspaceCommand = useRef(false);
  const workspacePickerActive = useRef(false);
  const emptyDraftRequest = useRef<string | null>(null);
  const creatingThread = useRef(false);
  const [pendingThreadSelections, setPendingThreadSelections] = useState(0);
  const [newDraftRequested, setNewDraftRequested] = useState(false);
  const drafts = useDesktopComposerDraft();
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia("(max-width: 1023px)").matches,
  );
  const appServerClient = useMemo(
    () =>
      build
        ? createAppServerClient({
            clientId: "legioncode-desktop",
            clientVersion: build.version,
            transport: {
              request: (envelope) => window.desktop.request(envelope),
            },
          })
        : null,
    [build?.version],
  );

  const {
    sdkReady,
    configurationOptions: turnConfigurationOptions,
    workspace,
    state: workspaceBootstrapState,
    retry: retryWorkspaceRead,
    acceptWorkspace: setWorkspace,
  } = useDesktopWorkspaceBootstrap({
    client: appServerClient,
    environmentReady: environment?.status === "ready",
    scope: threadScope,
    commandActive: workspaceCommand,
    pickerOpen: workspacePickerOpen,
    onScopeReset: () => {
      threadScope.current += 1;
      selectionRequest.current += 1;
      threadListRequest.current += 1;
      setThreads([]);
      setSelectedThread(null);
      setThreadError(null);
      setThreadLoadState("loading");
    },
    onReadStart: () => {
      selectionRequest.current += 1;
      threadListRequest.current += 1;
      setThreadError(null);
      setThreadLoadState("loading");
    },
    onWorkspaceReady: () => { void refreshThreads(); },
    onWorkspaceUnavailable: () => {
      selectionRequest.current += 1;
      threadListRequest.current += 1;
      setThreads([]);
      setSelectedThread(null);
      setThreadLoadState("ready");
    },
    onInitializeError: () => setThreadLoadState("error"),
  });

  const projects = useDesktopProjectNavigation({
    client: appServerClient,
    enabled: sdkReady,
    revision: workspace?.grantedAt ?? null,
  });
  const sidebarThreads = useMemo(() => {
    const metadata = new Map((projects.navigation?.threads ?? []).map((thread) => [thread.id, thread]));
    for (const thread of threads) metadata.set(thread.id, thread);
    return [...metadata.values()];
  }, [projects.navigation, threads]);

  useDesktopPendingTitleProjectionRefresh({
    client: appServerClient,
    enabled: sdkReady && environment?.status === "ready" && environment.kind === "local" &&
      environment.capabilities.includes("thread-management-v1") && threadLoadState === "ready" &&
      !workspaceBusy && !workspacePickerOpen && !projects.intent,
    workspace, threads, generation: threadScope, setThreads, setSelectedThread,
  });

  const reviewScope = useMemo(
    () =>
      appServerClient &&
      sdkReady &&
      environment?.status === "ready" &&
      environment.kind === "local" &&
      workspace?.readiness === "ready" &&
      selectedThread?.workspaceId === workspace.workspaceId
        ? {
            client: appServerClient,
            workspaceId: workspace.workspaceId,
            threadId: selectedThread.id,
            grantedAt: workspace.grantedAt,
            readiness: workspace.readiness,
          }
        : null,
    [
      appServerClient,
      sdkReady,
      environment?.status,
      environment?.kind,
      workspace?.workspaceId,
      workspace?.grantedAt,
      workspace?.readiness,
      selectedThread?.workspaceId,
      selectedThread?.id,
    ],
  );
  const savedReview = useDesktopSavedReviewSelection(
    reviewScope,
    environment?.status === "ready" &&
      environment.capabilities.includes("artifact-review-v1"),
  );
  const reviewSourceKey = JSON.stringify([workspace?.workspaceId, workspace?.grantedAt, selectedThread?.id]);
  const activeReviewSource = reviewSource?.key === reviewSourceKey ? reviewSource.value : "turn-diff";

  useEffect(() => { setSettingsTarget(null); }, [workspace?.workspaceId, workspace?.grantedAt, workspace?.readiness]);
  useEffect(() => { setCommitOpen(false); }, [
    appServerClient, sdkReady, workspace?.workspaceId,
    workspace?.grantedAt, workspace?.readiness,
    selectedThread?.id, savedReview.selection?.turnId,
  ]);

  useEffect(() => {
    const compactLayout = window.matchMedia("(max-width: 1023px)");
    const closeSidebarOnCompact = (event: MediaQueryListEvent): void => {
      if (event.matches) setSidebarOpen(false);
    };
    compactLayout.addEventListener("change", closeSidebarOnCompact);
    return () =>
      compactLayout.removeEventListener("change", closeSidebarOnCompact);
  }, []);

  useEffect(() => {
    void window.desktop.getBuildInfo().then(setBuild);
    void window.desktop.getEnvironment().then(setEnvironment);
    return window.desktop.onEnvironmentStatus(setEnvironment);
  }, []);

  useEffect(() => {
    if (
      !sdkReady ||
      workspace?.readiness !== "ready" ||
      threadLoadState !== "ready" ||
      selectedThread ||
      threadError ||
      pendingThreadSelections > 0 ||
      projects.intent ||
      workspacePickerOpen ||
      workspaceBusy ||
      workspacePickerActive.current
    )
      return;
    const latest = threads.find((thread) => thread.status !== "archived");
    if (latest && !drafts.hasUnboundDraft && !newDraftRequested) {
      setSelectedThread(latest);
      return;
    }
    const intent = `${workspace.workspaceId}:${workspace.grantedAt}:${threads.map((thread) => thread.id).join(":")}`;
    if (emptyDraftRequest.current === intent) return;
    emptyDraftRequest.current = intent;
    void createThread(undefined, true);
  }, [
    sdkReady,
    workspace?.workspaceId,
    workspace?.grantedAt,
    workspace?.readiness,
    threadLoadState,
    selectedThread,
    threadError,
    threads,
    drafts.hasUnboundDraft,
    newDraftRequested,
    pendingThreadSelections,
    projects.intent,
    workspacePickerOpen,
    workspaceBusy,
  ]);

  async function refreshThreads(preferredSelectionId?: string): Promise<void> {
    const scope = threadScope.current;
    const request = ++threadListRequest.current;
    const selection = selectionRequest.current;
    setThreadLoadState("loading");
    try {
      if (!appServerClient) return;
      const nextThreads = await appServerClient.listThreads();
      if (
        scope !== threadScope.current ||
        request !== threadListRequest.current
      )
        return;
      setThreads(nextThreads);
      void projects.refresh();
      setThreadLoadState("ready");
      if (selection === selectionRequest.current) {
        setSelectedThread((current) => {
          const selectionId = preferredSelectionId ?? current?.id;
          return (
            nextThreads.find((thread) => thread.id === selectionId) ?? null
          );
        });
      }
    } catch {
      if (
        scope !== threadScope.current ||
        request !== threadListRequest.current
      )
        return;
      setThreadLoadState("error");
    }
  }

  async function createThread(title?: string, fromUnboundDraft = false, granted = workspace): Promise<void> {
    if (!appServerClient || !sdkReady || granted?.readiness !== "ready" || creatingThread.current) return;
    creatingThread.current = true;
    setPendingThreadSelections((count) => count + 1);
    const scope = threadScope.current;
    const request = ++selectionRequest.current;
    const workspaceId = granted.workspaceId;
    const ticket = fromUnboundDraft ? drafts.captureHandoff() : null;
    setThreadError(null);
    try {
      const created = await appServerClient.createThread(
        title?.trim() || undefined,
        { workspaceId: granted.workspaceId, grantedAt: granted.grantedAt },
      );
      if (scope !== threadScope.current || created.workspaceId !== workspaceId) return;
      if (request === selectionRequest.current) {
        if (ticket && !drafts.adoptCreatedThread(ticket, created)) return;
        setNewDraftRequested(false);
        setSelectedThread(created);
        await refreshThreads(created.id);
      } else {
        await refreshThreads();
      }
    } catch {
      if (
        scope === threadScope.current &&
        request === selectionRequest.current
      ) {
        setThreadError("The local thread could not be created.");
      }
    } finally {
      creatingThread.current = false;
      setPendingThreadSelections((count) => count - 1);
    }
  }

  async function requestProjectAccess(intent: DesktopProjectIntent): Promise<void> {
    if (!sdkReady || workspaceCommand.current || workspacePickerActive.current) return;
    projects.capture(intent);
    selectionRequest.current += 1;
    drafts.cancelHandoff();
    setSelectedThread(null);
    setThreadError(null);
    emptyDraftRequest.current = null;
    const project = projects.navigation?.projects.find((item) => item.workspaceId === intent.workspaceId);
    if (project?.association !== "known") {
      setThreadError("This saved project's folder association is unavailable. Explicit project recovery is required before its tasks can be opened.");
      return;
    }
    await chooseWorkspace(true);
  }

  function startNewTask(workspaceSelectionId?: string): void {
    closeCompactSidebar();
    if (workspaceCommand.current || workspacePickerActive.current || creatingThread.current) return;
    if (workspaceSelectionId && (workspace?.workspaceId !== workspaceSelectionId || workspace.readiness !== "ready")) {
      const project = projects.navigation?.projects.find((item) => item.workspaceId === workspaceSelectionId);
      if (!project) {
        setThreadError("The selected project could not be loaded.");
        return;
      }
      void requestProjectAccess({ workspaceId: project.workspaceId, action: { kind: "create" } });
      return;
    }
    projects.clear();
    setThreadError(null);
    emptyDraftRequest.current = null;
    if (workspace?.readiness === "ready" && sdkReady) {
      void createThread(undefined, !selectedThread);
      return;
    }
    selectionRequest.current += 1;
    drafts.cancelHandoff();
    setSelectedThread(null);
    setNewDraftRequested(true);
  }

  async function openThread(threadId: string, granted = workspace): Promise<void> {
    if (workspaceCommand.current || workspacePickerActive.current) return;
    const knownThread = sidebarThreads.find((thread) => thread.id === threadId);
    if (!knownThread) return;
    if (granted?.readiness !== "ready" || knownThread.workspaceId !== granted.workspaceId) {
      await requestProjectAccess({ workspaceId: knownThread.workspaceId, action: { kind: "open", threadId: knownThread.id } });
      return;
    }
    const scope = threadScope.current;
    drafts.cancelHandoff();
    setNewDraftRequested(false);
    setPendingThreadSelections((count) => count + 1);
    const request = ++selectionRequest.current;
    setThreadError(null);
    try {
      if (!appServerClient || !sdkReady) return;
      const opened = await appServerClient.getThread(knownThread.id);
      if (scope !== threadScope.current || request !== selectionRequest.current) return;
      if (opened.id !== knownThread.id || opened.workspaceId !== granted.workspaceId) {
        setThreadError("The task does not belong to the granted project.");
        return;
      }
      setSelectedThread(opened);
    } catch {
      if (scope === threadScope.current && request === selectionRequest.current) {
        setThreadError("The local thread could not be opened.");
      }
    } finally {
      setPendingThreadSelections((count) => count - 1);
    }
  }

  function threadMutationUnavailableReason(threadId: string): string | undefined {
    const thread = sidebarThreads.find((item) => item.id === threadId);
    if (!thread) return "The local task is unavailable.";
    if (!sdkReady || workspaceBusy || workspaceCommand.current || workspacePickerActive.current) {
      return "Task actions are unavailable while project access is changing.";
    }
    if (workspace?.readiness !== "ready" || thread.workspaceId !== workspace.workspaceId) {
      const project = projects.navigation?.projects.find((item) => item.workspaceId === thread.workspaceId);
      return project?.association === "unlinked"
        ? "Recover this saved project's folder association before changing its tasks."
        : "Open this task and restore its project's access before changing it.";
    }
    if (!threads.some((item) => item.id === threadId)) {
      return "Load this project's tasks before changing them.";
    }
    return undefined;
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    const unavailableReason = threadMutationUnavailableReason(threadId);
    if (unavailableReason) {
      setThreadError(unavailableReason);
      throw new Error(unavailableReason);
    }
    const known = threads.find((thread) => thread.id === threadId);
    if (!known || !appServerClient)
      throw new Error("The local thread is unavailable.");
    const scope = threadScope.current;
    const request = selectionRequest.current;
    try {
      const renamed = await appServerClient.renameThread(known.id, title);
      if (scope !== threadScope.current) return;
      if (request === selectionRequest.current) {
        setSelectedThread((current) =>
          current?.id === renamed.id ? renamed : current,
        );
      }
      // A newer selection suppresses selection writes, not same-scope metadata refresh.
      await refreshThreads();
    } catch {
      if (scope !== threadScope.current || request !== selectionRequest.current)
        return;
      throw new Error("The local task could not be renamed. Check project access and try again.");
    }
  }

  async function archiveThread(threadId: string): Promise<void> {
    const unavailableReason = threadMutationUnavailableReason(threadId);
    if (unavailableReason) {
      setThreadError(unavailableReason);
      return;
    }
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    const scope = threadScope.current;
    const request = selectionRequest.current;
    try {
      if (!appServerClient) return;
      const updated = await appServerClient.archiveThread(thread.id);
      if (scope !== threadScope.current) return;
      if (
        request === selectionRequest.current &&
        selectedThread?.id === updated.id
      ) {
        setSelectedThread((current) =>
          current?.id === updated.id ? updated : current,
        );
      }
      await refreshThreads();
    } catch {
      if (scope !== threadScope.current || request !== selectionRequest.current)
        return;
      setThreadError("The local thread could not be updated.");
    }
  }

  async function unarchiveThread(threadId: string): Promise<void> {
    const unavailableReason = threadMutationUnavailableReason(threadId);
    if (unavailableReason) {
      setThreadError(unavailableReason);
      return;
    }
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("The archived task is no longer available.");
    const scope = threadScope.current;
    const request = selectionRequest.current;
    try {
      if (!appServerClient) throw new Error("The local environment is unavailable.");
      const updated = await appServerClient.unarchiveThread(thread.id);
      if (scope !== threadScope.current) throw new Error("The workspace scope changed.");
      if (
        request === selectionRequest.current &&
        selectedThread?.id === updated.id
      ) {
        setSelectedThread((current) =>
          current?.id === updated.id ? updated : current,
        );
      }
      await refreshThreads();
    } catch {
      if (scope === threadScope.current && request === selectionRequest.current)
        setThreadError("The local thread could not be updated.");
      throw new Error("The local thread could not be unarchived.");
    }
  }

  async function setThreadPinned(
    threadId: string,
    pinned: boolean,
  ): Promise<void> {
    const unavailableReason = threadMutationUnavailableReason(threadId);
    if (unavailableReason) {
      setThreadError(unavailableReason);
      return;
    }
    const thread = threads.find((item) => item.id === threadId);
    if (!thread || !appServerClient) return;
    const scope = threadScope.current;
    const request = selectionRequest.current;
    try {
      const updated = pinned
        ? await appServerClient.pinThread(thread.id)
        : await appServerClient.unpinThread(thread.id);
      if (scope !== threadScope.current) return;
      if (request === selectionRequest.current) {
        setSelectedThread((current) =>
          current?.id === updated.id ? updated : current,
        );
      }
      await refreshThreads();
    } catch {
      if (scope !== threadScope.current || request !== selectionRequest.current)
        return;
      setThreadError("The local thread could not be updated.");
    }
  }

  const chooseWorkspace = useDesktopWorkspacePicker({
    enabled: sdkReady,
    commandActive: workspaceCommand,
    pickerActive: workspacePickerActive,
    onOpenChange: setWorkspacePickerOpen,
    onStart: (preserveProjectIntent) => {
      if (!preserveProjectIntent) projects.clear();
      setWorkspaceError(null);
    },
    onPicked: grantWorkspace,
    onCancel: () => {
      if (projects.currentIntent.current) {
        setThreadError("Project access was not changed. Choose the selected project's folder to continue, or select another task.");
      }
    },
    onError: () => setWorkspaceError("The folder could not be added. Choose it again to retry."),
  });

  async function grantWorkspace(selection: WorkspaceSelection): Promise<void> {
    if (!sdkReady || !appServerClient || workspaceCommand.current) return;
    workspaceCommand.current = true;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    const intent = projects.currentIntent.current;
    threadScope.current += 1;
    selectionRequest.current += 1;
    threadListRequest.current += 1;
    const commandScope = threadScope.current;
    // Fence old command deliveries, but retain the mounted conversation/draft
    // until the actual grant succeeds. A failed receipt must not erase it.
    let granted: LocalWorkspaceGrant;
    try {
      if (!appServerClient) return;
      granted = await appServerClient.grantWorkspace({
        selectionToken: selection.selectionToken,
      });
    } catch (error: unknown) {
      if (commandScope !== threadScope.current) return;
      setThreadError("Workspace access could not be confirmed. Choose a folder again before opening or creating a task.");
      setWorkspaceError(
        error instanceof AppServerClientError && error.code === "server_error" &&
        error.method === "workspace/grant" && error.serverError
          ? error.message
          : "Workspace access could not be confirmed.",
      );
      return;
    } finally {
      workspaceCommand.current = false;
      setWorkspaceBusy(false);
    }

    if (threadScope.current !== commandScope) return;
    threadScope.current += 1;
    selectionRequest.current += 1;
    threadListRequest.current += 1;
    setSelectedThread(null);
    setThreadError(null);
    setThreads([]);
    setWorkspace(granted);
    closeCompactSidebar();
    void projects.refresh();
    if (intent && projects.currentIntent.current === intent) {
      if (granted.workspaceId !== intent.workspaceId || granted.readiness !== "ready") {
        setThreadError("The chosen folder does not restore the selected project. Choose that project's folder before opening or creating its tasks.");
        return;
      }
      if (intent.action.kind === "open") await openThread(intent.action.threadId, granted);
      else await createThread(undefined, true, granted);
      projects.clear(intent);
    }
    if (granted.readiness === "ready") await refreshThreads();
  }

  async function removeProject(workspaceSelectionId: string): Promise<void> {
    if (!appServerClient || !sdkReady || workspaceCommand.current || workspacePickerActive.current) return;
    const project = projects.navigation?.projects.find((item) => item.workspaceId === workspaceSelectionId);
    if (!project) {
      setThreadError("The selected project could not be loaded.");
      return;
    }
    workspaceCommand.current = true;
    setWorkspaceBusy(true);
    const wasCurrent = workspace?.workspaceId === project.workspaceId;
    if (wasCurrent) {
      threadScope.current += 1;
      selectionRequest.current += 1;
      threadListRequest.current += 1;
      setSelectedThread(null);
    }
    const commandScope = threadScope.current;
    let forgotten = false;
    try {
      await appServerClient.forgetLocalWorkspaceProject(project.workspaceId);
      forgotten = true;
      await projects.refresh();
      const current = await appServerClient.getWorkspaceGrant();
      if (commandScope !== threadScope.current) return;
      const scopeChanged = wasCurrent || current?.workspaceId !== workspace?.workspaceId ||
        current?.grantedAt !== workspace?.grantedAt || current?.readiness !== workspace?.readiness;
      if (scopeChanged) {
        threadScope.current += 1;
        selectionRequest.current += 1;
        threadListRequest.current += 1;
        setWorkspace(current);
        setSelectedThread(null);
        setThreads([]);
        setThreadLoadState("ready");
        setThreadError("The project was removed from the sidebar. Select a task or choose a project to continue.");
      }
      if (projects.currentIntent.current?.workspaceId === project.workspaceId) {
        projects.clear();
        setThreadError("The project was removed from the sidebar. Select a task or choose a project to continue.");
      }
      if (scopeChanged && current?.readiness === "ready") await refreshThreads();
    } catch {
      if (commandScope !== threadScope.current) return;
      if (forgotten) setSelectedThread(null);
      setThreadError(forgotten
        ? "The project was removed, but current workspace access could not be loaded. Choose a folder again to continue."
        : "The project could not be removed from the sidebar.");
    } finally {
      workspaceCommand.current = false;
      setWorkspaceBusy(false);
    }
  }

  if (!build || !environment) {
    return <ClientShellLoading label="Loading Desktop" />;
  }

  const projectChangeUnavailableReason = !sdkReady || environment.status !== "ready"
    ? "Reconnect Desktop before changing projects."
    : workspaceBusy || workspacePickerOpen || pendingThreadSelections > 0 ||
      workspaceBootstrapState.status === "connecting" || workspaceBootstrapState.status === "loading"
      ? "Wait for project access to finish before changing projects."
      : undefined;

  const environmentSummary = (onOpenChanges: () => void) => selectedThread ? (
    <EnvironmentSummaryMenu
      commandExecution={sdkReady && environment.kind === "local" && environment.status === "ready"
        ? turnConfigurationOptions?.commandExecution : undefined}
      repo={workspace ? { default_branch: workspace.branch ?? "" } : null}
      branch={workspace?.branch ?? ""}
      readOnlyBranch={Boolean(workspace?.branch)}
      changedFileCount={activeReviewSource === "turn-diff" && savedReview.read.status === "ready" ? savedReview.read.diff?.files.length : undefined}
      onOpenChanges={savedReview.selection || environment.capabilities.includes("workspace-git-reads-v1") ? onOpenChanges : undefined}
      onOpenCommit={
        activeReviewSource === "turn-diff" &&
        sdkReady && environment.status === "ready" &&
        environment.capabilities.includes("artifact-commit-v1") &&
        savedReview.read.status === "ready" && savedReview.read.diff?.files.length
          ? () => setCommitOpen(true)
          : undefined
      }
      pullRequestResult={{ status: "unavailable", sessionId: selectedThread.id }}
    />
  ) : null;

  const renderedThreadScope = threadScope.current;

  function closeCompactSidebar(): void {
    if (window.matchMedia("(max-width: 1023px)").matches) setSidebarOpen(false);
  }

  return (
    <>
      <ClientShell
        environment={environment.status === "ready" ? undefined : environment}
        onEnvironmentRetry={() => void window.desktop.restartEnvironment()}
      >
        <WorkspaceFrame
          className="desktop-workspace-frame"
          sidebarOpen={sidebarOpen}
          onSidebarOpenChange={setSidebarOpen}
          sidebar={
            <DesktopSidebar
              width={320}
              workspace={workspace}
              projects={projects.navigation?.projects ?? []}
              threads={sidebarThreads}
              selectedThreadId={selectedThread?.id ?? null}
              loadState={workspaceBootstrapState.status === "error" ? "error" : projects.status}
              threadError={threadError ?? (projects.status === "error" ? "The local project list could not be loaded." : null) ?? (!workspacePickerOpen ? workspaceError ?? (workspaceBootstrapState.status === "error" ? workspaceBootstrapState.message : null) : null)}
              canManageWorkspace={(id) => sdkReady && !workspaceBusy && Boolean(projects.navigation?.projects.some((project) => project.workspaceId === id))}
              onRemoveWorkspace={removeProject}
              onOpenSettings={() => {
                closeCompactSidebar();
                setSettingsTarget("general");
              }}
              visible={sidebarOpen}
              onSelect={(threadId) => {
                closeCompactSidebar();
                if (workspaceCommand.current || workspacePickerActive.current) return;
                projects.clear();
                void openThread(threadId);
              }}
              onCreate={startNewTask}
              onAddWorkspace={
                sdkReady ? () => void chooseWorkspace() : undefined
              }
              onRenameSession={renameThread}
              threadMutationUnavailableReason={threadMutationUnavailableReason}
              onPin={(threadId) => setThreadPinned(threadId, true)}
              onUnpin={(threadId) => setThreadPinned(threadId, false)}
              onArchive={archiveThread}
              onUnarchive={(id) => unarchiveThread(id).catch(() => {})}
              onClose={() => setSidebarOpen(false)}
            />
          }
          topBar={
            <WorkspaceTopBar
              title={selectedThread?.title}
              actions={<>
                {environmentSummary(() => {
                  setRightPanelOpen(true);
                  setChangesRequestId((id) => id + 1);
                })}
                {!rightPanelOpen ? (
                  <WorkspaceReviewControls
                    onToggleRightSidebar={() => setRightPanelOpen((open) => !open)}
                    toggleButtonRef={rightPanelToggleRef}
                  />
                ) : null}
              </>}
            />
          }
          rightPanel={
            rightPanelOpen ? (
              <DesktopRightPanel
                headerWidth={rightPanelWidth}
                changesRequestId={changesRequestId}
                onResize={(delta) => setRightPanelWidth((width) => clampRightSidebarWidth(width + delta))}
                workspace={workspace}
                threadId={selectedThread?.id ?? null}
                review={
                  appServerClient && sdkReady && environment.status === "ready" &&
                  environment.kind === "local" && workspace?.readiness === "ready"
                    ? {
                        scope: {
                          workspaceId: workspace.workspaceId,
                          grantedAt: workspace.grantedAt,
                          readiness: workspace.readiness,
                          threadId: selectedThread?.id ?? null,
                        },
                        selection: savedReview.selection,
                        content: (controls) => (
                          <DesktopWorkspaceReview
                            client={appServerClient}
                            workspaceId={workspace.workspaceId}
                            liveAvailable={environment.capabilities.includes("workspace-git-reads-v1")}
                            controls={controls}
                            scopeControls={{
                              value: activeReviewSource,
                              onChange: (value) => {
                                setReviewSource({ key: reviewSourceKey, value });
                                setCommitOpen(false);
                              },
                              availableScopes: environment.capabilities.includes("workspace-git-reads-v1")
                                ? ["turn-diff", "git-changes"] : ["turn-diff"],
                            }}
                            saved={{
                              read: savedReview.read,
                              onRetry: savedReview.retry,
                              selection: savedReview.selection,
                              scope: reviewScope ? {
                                workspaceId: reviewScope.workspaceId,
                                threadId: reviewScope.threadId,
                                grantGrantedAt: reviewScope.grantedAt,
                              } : null,
                              availability: environment.capabilities.includes("artifact-review-v1")
                                ? { available: true }
                                : {
                                    available: false,
                                    reason:
                                      "This environment does not provide saved turn review.",
                                  },
                            }}
                          />
                        ),
                      }
                    : null
                }
                files={
                  appServerClient &&
                  sdkReady &&
                  environment.status === "ready" &&
                  environment.kind === "local" &&
                  workspace?.readiness === "ready"
                    ? {
                        workspaceId: workspace.workspaceId,
                        grantedAt: workspace.grantedAt,
                        readiness: workspace.readiness,
                        content: (controls) => (
                          <DesktopWorkspaceFilesMount
                            controls={controls}
                            client={appServerClient}
                            workspaceId={workspace.workspaceId}
                            grantedAt={workspace.grantedAt}
                            readiness={workspace.readiness}
                            availability={
                              environment.capabilities.includes(
                                "workspace-files-v1",
                              )
                                ? { available: true }
                                : {
                                    available: false,
                                    reason:
                                      environment.unavailableCapabilities.find(
                                        (item) =>
                                          item.capability ===
                                          "workspace-files-v1",
                                      )?.reason ??
                                      "This local environment does not provide workspace file reads.",
                                  }
                            }
                          />
                        ),
                      }
                    : undefined
                }
                filesUnavailableReason="Local workspace file reads are unavailable in this environment."
                onClose={() => {
                  restoreRightPanelFocus.current = true;
                  setRightPanelOpen(false);
                }}
              />
            ) : undefined
          }
          rightPanelWidth={rightPanelWidth}
          rightPanelLabel="Files and saved turn review"
        >
          <WorkspaceSummaryLayout>
          {workspace?.readiness === "ready" &&
          selectedThread &&
          appServerClient &&
          sdkReady ? (
            <DesktopConversation
              key={`${workspace.workspaceId}:${workspace.grantedAt}:${workspace.readiness}`}
              client={appServerClient}
              thread={selectedThread}
              draftHandoff={drafts.handoffFor(selectedThread)}
              providerReady={sdkReady}
              workspaceGrantAt={workspace.grantedAt}
              fileAvailability={environment.status === "ready" && environment.capabilities.includes("workspace-files-v1") ? { available: true } : { available: false, reason: "Workspace file suggestions are unavailable in this environment." }}
              projectName={workspace.displayName}
              projectChangeUnavailableReason={projectChangeUnavailableReason}
              onProjectClick={() => void chooseWorkspace()}
              execution={
                environment.status === "ready" &&
                environment.capabilities.includes("turn-execution-v1")
                  ? { available: true }
                  : {
                      available: false,
                      reason:
                        "Local execution is unavailable in this environment.",
                    }
              }
              onConnectProvider={() => setSettingsTarget("connect-only")}
              onManageModels={() => setSettingsTarget("manage-models-only")}
              providerRevision={providerRevision}
              configurationOptions={turnConfigurationOptions}
              onAdmissionConfirmed={(admission) => {
                if (renderedThreadScope !== threadScope.current ||
                    admission.run.workspaceId !== workspace.workspaceId ||
                    admission.turn.threadId !== selectedThread.id) return;
                void refreshThreads();
              }}
              onReviewTurn={(turn) => {
                if (renderedThreadScope !== threadScope.current ||
                    turn.workspaceId !== workspace.workspaceId ||
                    turn.threadId !== selectedThread.id) return;
                savedReview.select(turn);
                setReviewSource({ key: reviewSourceKey, value: "turn-diff" });
                setRightPanelOpen(true);
              }}
            />
          ) : (
            <DesktopWorkspaceBootstrapHero
              showProjectChip={false}
              workspace={workspace}
              state={workspaceBootstrapState}
              threadLoadState={threadLoadState}
              threadError={threadError}
              onRetryThreads={() => { if (sdkReady) void refreshThreads(); }}
              onChoose={() => void chooseWorkspace(Boolean(projects.currentIntent.current))}
              onRetry={retryWorkspaceRead}
              canChoose={sdkReady && !workspaceBusy && !workspacePickerOpen}
              canRetry={environment.status === "ready" && !workspaceBusy && !workspacePickerOpen}
            >
              <DesktopComposer
                workspaceBar={
                  <DesktopComposerWorkspaceBar
                    scopeKey={`unbound:${workspace?.workspaceId ?? "none"}:${workspace?.grantedAt ?? "none"}:${projects.intent?.workspaceId ?? "none"}`}
                    projectName={!projects.intent ? workspace?.displayName : undefined}
                    onChooseProject={() => void chooseWorkspace(Boolean(projects.currentIntent.current))}
                    disabledReason={projectChangeUnavailableReason}
                  />
                }
                client={appServerClient}
                workspaceId={!projects.intent && workspace?.readiness === "ready" ? workspace.workspaceId : null}
                grantedAt={!projects.intent && workspace?.readiness === "ready" ? workspace.grantedAt : null}
                threadId={null}
                providerReady={sdkReady}
                unboundDraft={drafts.unbound}
                fileAvailability={{ available: false, reason: "Restore project access to browse files." }}
                busy={false}
                layout="hero"
                submissionUnavailableReason={workspace?.readiness === "ready"
                  ? "Open or create a task to send your message."
                  : "Choose or restore a project to send your message."}
                onConnectProvider={() => setSettingsTarget("connect-only")}
                onManageModels={() => setSettingsTarget("manage-models-only")}
                providerRevision={providerRevision}
                configurationOptions={turnConfigurationOptions}
                initialConfiguration={null}
                pendingConfiguration={null}
                pendingSelection={null}
              />
            </DesktopWorkspaceBootstrapHero>
          )}
          </WorkspaceSummaryLayout>
        </WorkspaceFrame>
      </ClientShell>
      {appServerClient ? (
        <DesktopSavedCommitDialog
          key={JSON.stringify([
            workspace?.workspaceId, workspace?.grantedAt,
            selectedThread?.id, savedReview.selection?.turnId,
          ])}
          isOpen={commitOpen && activeReviewSource === "turn-diff"}
          onClose={() => setCommitOpen(false)}
          client={appServerClient}
          selection={savedReview.selection}
          diff={savedReview.read.status === "ready" ? savedReview.read.diff : null}
          scope={reviewScope}
          availability={
            sdkReady && environment.status === "ready" &&
            environment.capabilities.includes("artifact-commit-v1")
              ? { available: true }
              : { available: false, reason: "Committing saved changes is unavailable in this Desktop runtime." }
          }
        />
      ) : null}
      <DesktopSettingsDialog
        open={settingsTarget !== null}
        providerDialogVariant={settingsTarget === "general" ? null : settingsTarget}
        onUnarchiveThread={unarchiveThread}
        onClose={() => {
          setSettingsTarget(null);
          setProviderRevision((value) => value + 1);
        }}
        client={appServerClient}
        ready={sdkReady}
        build={build}
      />
    </>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Desktop renderer root is missing");
}

createRoot(root).render(
  <StrictMode>
    <ClientErrorBoundary>
      <DesktopApp />
    </ClientErrorBoundary>
  </StrictMode>,
);
