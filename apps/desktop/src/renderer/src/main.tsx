import {
  ClientErrorBoundary,
  ClientShell,
  ClientShellLoading,
  ConversationHero,
  getInitialRightSidebarWidth,
  clampRightSidebarWidth,
  FilesToggleButton,
  PickerModal,
  WorkspaceFrame,
  WorkspaceTopBar,
} from "@legioncode/client-ui";
import { createAppServerClient } from "@legioncode/sdk";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";
import type { LocalWorkspaceGrant, Thread } from "@repo/platform-protocol";

import type {
  DesktopBuildInfo,
  WorkspaceSelection,
} from "../../shared/desktop-api";
import { DesktopSidebar } from "./DesktopSidebar";
import { DesktopWorkspaceControls } from "./DesktopWorkspaceControls";
import { DesktopSettingsDialog } from "./DesktopSettingsDialog";
import { DesktopRightPanel } from "./DesktopRightPanel";
import { DesktopWorkspaceFilesMount } from "./DesktopWorkspaceFilesMount";
import { DesktopConversation } from "./DesktopConversation";
import { DesktopReview } from "./DesktopReview";
import { useDesktopSavedReviewSelection } from "./useDesktopSavedReviewSelection";
import "./styles.css";

type ThreadLoadState = "loading" | "ready" | "error";

function DesktopApp(): React.JSX.Element {
  const selectionRequest = useRef(0);
  const threadScope = useRef(0);
  const threadListRequest = useRef(0);
  const [build, setBuild] = useState<DesktopBuildInfo | null>(null);
  const [environment, setEnvironment] =
    useState<AppServerEnvironmentSnapshot | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [workspace, setWorkspace] = useState<LocalWorkspaceGrant | null>(null);
  const [selection, setSelection] = useState<WorkspaceSelection | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadLoadState, setThreadLoadState] =
    useState<ThreadLoadState>("loading");
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerRevision, setProviderRevision] = useState(0);
  const [rightPanelOpen, setRightPanelOpen] = useState(
    () => window.matchMedia("(min-width: 1280px)").matches,
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(() => getInitialRightSidebarWidth(window.innerWidth));
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const workspaceCommand = useRef(false);
  const emptyDraftRequest = useRef<string | null>(null);
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
  const savedReview = useDesktopSavedReviewSelection(reviewScope);

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
    setSdkReady(false);
    threadScope.current += 1;
    selectionRequest.current += 1;
    threadListRequest.current += 1;
    setSelectedThread(null);
    if (!appServerClient || environment?.status !== "ready") return;
    let active = true;
    void appServerClient
      .initialize()
      .then(() => {
        if (active) setSdkReady(true);
      })
      .catch(() => {
        if (active) setThreadLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [appServerClient, environment?.status]);

  useEffect(() => {
    if (!appServerClient || !sdkReady) {
      return;
    }
    let active = true;
    const scope = threadScope.current;
    setThreadLoadState("loading");
    void appServerClient
      .getWorkspaceGrant()
      .then(async (nextWorkspace) => {
        if (!active || scope !== threadScope.current) return;
        setWorkspace(nextWorkspace);
        if (nextWorkspace?.readiness === "ready") {
          await refreshThreads();
        } else {
          setThreads([]);
          setSelectedThread(null);
          setThreadLoadState("ready");
        }
      })
      .catch(() => {
        if (!active || scope !== threadScope.current) return;
        setWorkspaceError("The local workspace grant could not be loaded.");
        setThreadLoadState("ready");
      });
    return () => {
      active = false;
    };
  }, [appServerClient, sdkReady]);

  useEffect(() => {
    if (
      !sdkReady ||
      workspace?.readiness !== "ready" ||
      threadLoadState !== "ready" ||
      selectedThread ||
      threadError
    )
      return;
    const latest = threads.find((thread) => thread.status !== "archived");
    if (latest) {
      setSelectedThread(latest);
      return;
    }
    const intent = `${workspace.workspaceId}:${workspace.grantedAt}:${threads.map((thread) => thread.id).join(":")}`;
    if (emptyDraftRequest.current === intent) return;
    emptyDraftRequest.current = intent;
    void createThread();
  }, [
    sdkReady,
    workspace?.workspaceId,
    workspace?.grantedAt,
    workspace?.readiness,
    threadLoadState,
    selectedThread,
    threadError,
    threads,
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

  async function createThread(title?: string): Promise<void> {
    const scope = threadScope.current;
    const request = ++selectionRequest.current;
    setThreadError(null);
    try {
      if (!appServerClient) return;
      const created = await appServerClient.createThread(
        title?.trim() || undefined,
      );
      if (scope !== threadScope.current) return;
      if (request === selectionRequest.current) {
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
    }
  }

  async function openThread(threadId: string): Promise<void> {
    const knownThread = threads.find((thread) => thread.id === threadId);
    if (!knownThread) return;
    const request = ++selectionRequest.current;
    setThreadError(null);
    try {
      if (!appServerClient) return;
      const opened = await appServerClient.getThread(knownThread.id);
      if (request !== selectionRequest.current) return;
      setSelectedThread(opened);
    } catch {
      if (request === selectionRequest.current) {
        setThreadError("The local thread could not be opened.");
      }
    }
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
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
      throw new Error("Thread titles must contain 1 to 80 characters.");
    }
  }

  async function archiveThread(threadId: string): Promise<void> {
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
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    const scope = threadScope.current;
    const request = selectionRequest.current;
    try {
      if (!appServerClient) return;
      const updated = await appServerClient.unarchiveThread(thread.id);
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

  async function setThreadPinned(
    threadId: string,
    pinned: boolean,
  ): Promise<void> {
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

  async function chooseWorkspace(): Promise<void> {
    setWorkspaceError(null);
    try {
      const picked = await window.desktop.pickWorkspace();
      setSelection(picked);
      if (picked) setSidebarOpen(true);
    } catch {
      setWorkspaceError("The native workspace picker could not be opened.");
    }
  }

  async function grantWorkspace(): Promise<void> {
    if (!selection || workspaceCommand.current) return;
    workspaceCommand.current = true;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    let granted: LocalWorkspaceGrant;
    try {
      if (!appServerClient) return;
      granted = await appServerClient.grantWorkspace({
        selectionToken: selection.selectionToken,
      });
    } catch {
      setWorkspaceError("The selected directory is not a Git repository root.");
      return;
    } finally {
      workspaceCommand.current = false;
      setWorkspaceBusy(false);
    }

    threadScope.current += 1;
    selectionRequest.current += 1;
    threadListRequest.current += 1;
    setSelectedThread(null);
    setThreads([]);
    setWorkspace(granted);
    setSelection(null);
    if (granted.readiness === "ready") await refreshThreads();
  }

  async function revokeWorkspace(): Promise<void> {
    if (workspaceCommand.current) return;
    workspaceCommand.current = true;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      if (!appServerClient) return;
      await appServerClient.revokeWorkspace();
      threadScope.current += 1;
      selectionRequest.current += 1;
      threadListRequest.current += 1;
      setWorkspace(null);
      setThreads([]);
      setSelectedThread(null);
      setThreadLoadState("ready");
    } catch {
      setWorkspaceError("The local workspace grant could not be revoked.");
    } finally {
      workspaceCommand.current = false;
      setWorkspaceBusy(false);
    }
  }

  if (!build || !environment) {
    return <ClientShellLoading label="Loading Desktop" />;
  }

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
              threads={threads}
              selectedThreadId={selectedThread?.id ?? null}
              loadState={threadLoadState}
              threadError={threadError ?? (!selection ? workspaceError : null)}
              canManageWorkspace={(id) => sdkReady && !workspaceBusy && workspace?.workspaceId === id}
              onRemoveWorkspace={async (id) => { if (workspace?.workspaceId === id) await revokeWorkspace(); }}
              onOpenSettings={() => {
                closeCompactSidebar();
                setSettingsOpen(true);
              }}
              visible={sidebarOpen}
              onSelect={(threadId) => {
                closeCompactSidebar();
                void openThread(threadId);
              }}
              onCreate={
                workspace?.readiness === "ready" && sdkReady
                  ? () => void createThread()
                  : undefined
              }
              onAddWorkspace={
                sdkReady ? () => void chooseWorkspace() : undefined
              }
              onRenameSession={renameThread}
              onPin={
                workspace?.readiness === "ready" && sdkReady
                  ? (threadId) => setThreadPinned(threadId, true)
                  : undefined
              }
              onUnpin={
                workspace?.readiness === "ready" && sdkReady
                  ? (threadId) => setThreadPinned(threadId, false)
                  : undefined
              }
              onArchive={archiveThread}
              onUnarchive={unarchiveThread}
              onClose={() => setSidebarOpen(false)}
            />
          }
          topBar={
            <WorkspaceTopBar
              title={selectedThread?.title}
              actions={
                <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
                  <FilesToggleButton
                    isOpen={rightPanelOpen}
                    onToggle={() => setRightPanelOpen((open) => !open)}
                  />
                </div>
              }
            />
          }
          rightPanel={
            rightPanelOpen ? (
              <DesktopRightPanel
                onResize={(delta) => setRightPanelWidth((width) => clampRightSidebarWidth(width + delta))}
                workspace={workspace}
                threadId={selectedThread?.id ?? null}
                review={
                  reviewScope
                    ? {
                        scope: reviewScope,
                        selection: savedReview.selection,
                        content: (controls) => (
                          <DesktopReview
                            controls={controls}
                            client={savedReview.client}
                            selection={savedReview.selection}
                            scope={{
                              workspaceId: reviewScope.workspaceId,
                              threadId: reviewScope.threadId,
                              grantGrantedAt: reviewScope.grantedAt,
                            }}
                            availability={
                              environment.status === "ready" &&
                              environment.capabilities.includes(
                                "artifact-review-v1",
                              )
                                ? { available: true }
                                : {
                                    available: false,
                                    reason:
                                      "This environment does not provide saved turn review.",
                                  }
                            }
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
                  setRightPanelOpen(false);
                  document
                    .querySelector<HTMLButtonElement>(
                      'button[aria-label="Toggle files sidebar"]',
                    )
                    ?.focus();
                }}
              />
            ) : undefined
          }
          rightPanelWidth={rightPanelWidth}
          rightPanelLabel="Files and saved turn review"
        >
          {workspace?.readiness === "ready" &&
          selectedThread &&
          appServerClient &&
          sdkReady ? (
            <DesktopConversation
              key={`${workspace.workspaceId}:${workspace.grantedAt}:${workspace.readiness}`}
              client={appServerClient}
              thread={selectedThread}
              projectName={workspace.displayName}
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
              onOpenSettings={() => setSettingsOpen(true)}
              providerRevision={providerRevision}
              onReviewTurn={(turn) => {
                savedReview.select(turn);
                setRightPanelOpen(true);
              }}
            />
          ) : (
            <ConversationHero
              projectName={workspace?.displayName}
              onProjectClick={() => void chooseWorkspace()}
            >
              {workspace?.readiness === "ready" &&
              threadLoadState === "loading" ? (
                <ClientShellLoading label="Loading conversation" />
              ) : null}
            </ConversationHero>
          )}
        </WorkspaceFrame>
      </ClientShell>
      {selection ? (
        <PickerModal>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Grant workspace access"
            className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100"
          >
            <DesktopWorkspaceControls
              workspace={workspace}
              selection={selection}
              ready={sdkReady}
              busy={workspaceBusy}
              error={workspaceError}
              onChoose={() => void chooseWorkspace()}
              onGrant={() => void grantWorkspace()}
              onCancelSelection={() => setSelection(null)}
              onRevoke={() => void revokeWorkspace()}
              onSettings={() => setSettingsOpen(true)}
            />
          </section>
        </PickerModal>
      ) : null}
      <DesktopSettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
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
