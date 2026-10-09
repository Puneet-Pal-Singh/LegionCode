import {
  ClientErrorBoundary,
  ClientShell,
  ClientShellLoading,
  ThreadSidebar,
  WorkspaceFrame,
  WorkspaceTopBar,
} from "@legioncode/client-ui";
import { createAppServerClient, projectThreadSidebar } from "@legioncode/sdk";
import type { ThreadSidebarDisplayStatus } from "@legioncode/sdk";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";
import type { LocalWorkspaceGrant, Thread } from "@repo/platform-protocol";

import type {
  DesktopBuildInfo,
  WorkspaceSelection,
} from "../../shared/desktop-api";
import { DesktopProviderSetup } from "./DesktopProviderSetup";
import { createDesktopAppServerTransport } from "../desktop-app-server-transport";
import "./styles.css";

type ThreadLoadState = "loading" | "ready" | "error";

function DesktopApp(): React.JSX.Element {
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
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [threadTitle, setThreadTitle] = useState("");
  const [threadError, setThreadError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia("(max-width: 1023px)").matches,
  );
  const appServerClient = useMemo(
    () => build
      ? createAppServerClient({
          clientId: "legioncode-desktop",
          clientVersion: build.version,
          transport: createDesktopAppServerTransport(window.desktop),
        })
      : null,
    [build?.version],
  );

  useEffect(() => {
    const compactLayout = window.matchMedia("(max-width: 1023px)");
    const closeSidebarOnCompact = (event: MediaQueryListEvent): void => {
      if (event.matches) setSidebarOpen(false);
    };
    compactLayout.addEventListener("change", closeSidebarOnCompact);
    return () => compactLayout.removeEventListener("change", closeSidebarOnCompact);
  }, []);

  useEffect(() => {
    void window.desktop.getBuildInfo().then(setBuild);
    void window.desktop.getEnvironment().then(setEnvironment);
    return window.desktop.onEnvironmentStatus(setEnvironment);
  }, []);

  useEffect(() => {
    setSdkReady(false);
    if (!appServerClient || environment?.status !== "ready") return;
    let active = true;
    void appServerClient.initialize().then(() => {
      if (active) setSdkReady(true);
    }).catch(() => {
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
    setThreadLoadState("loading");
    void appServerClient
      .getWorkspaceGrant()
      .then(async (nextWorkspace) => {
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
        setWorkspaceError("The local workspace grant could not be loaded.");
        setThreadLoadState("ready");
      });
  }, [appServerClient, sdkReady]);

  async function refreshThreads(preferredSelectionId?: string): Promise<void> {
    setThreadLoadState("loading");
    try {
      if (!appServerClient) return;
      const nextThreads = await appServerClient.listThreads();
      setThreads(nextThreads);
      setThreadLoadState("ready");
      const selectionId = preferredSelectionId ?? selectedThread?.id;
      if (selectionId) {
        const nextSelected = nextThreads.find(
          (thread) => thread.id === selectionId,
        ) ?? null;
        setSelectedThread(nextSelected);
        setThreadTitle(nextSelected?.title ?? "");
      }
    } catch {
      setThreadLoadState("error");
    }
  }

  async function createThread(title?: string): Promise<void> {
    setThreadError(null);
    try {
      if (!appServerClient) return;
      const created = await appServerClient.createThread(
        title?.trim() || undefined,
      );
      setNewThreadTitle("");
      setSelectedThread(created);
      setThreadTitle(created.title);
      await refreshThreads(created.id);
    } catch {
      setThreadError("The local thread could not be created.");
    }
  }

  async function openThread(threadId: string): Promise<void> {
    const knownThread = threads.find((thread) => thread.id === threadId);
    if (!knownThread) return;
    setThreadError(null);
    try {
      if (!appServerClient) return;
      const opened = await appServerClient.getThread(knownThread.id);
      setSelectedThread(opened);
      setThreadTitle(opened.title);
    } catch {
      setThreadError("The local thread could not be opened.");
    }
  }

  async function renameThread(): Promise<void> {
    if (!selectedThread) return;
    setThreadError(null);
    try {
      if (!appServerClient) return;
      const renamed = await appServerClient.renameThread(
        selectedThread.id,
        threadTitle,
      );
      setSelectedThread(renamed);
      await refreshThreads(renamed.id);
    } catch {
      setThreadError("Thread titles must contain 1 to 80 characters.");
    }
  }

  async function setThreadArchived(archived: boolean): Promise<void> {
    if (!selectedThread || !appServerClient) return;
    setThreadError(null);
    try {
      const updated = archived
        ? await appServerClient.archiveThread(selectedThread.id)
        : await appServerClient.unarchiveThread(selectedThread.id);
      setSelectedThread(updated);
      await refreshThreads(updated.id);
    } catch {
      setThreadError("The local thread could not be updated.");
    }
  }

  async function archiveThread(threadId: string): Promise<void> {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    try {
      if (!appServerClient) return;
      const updated = await appServerClient.archiveThread(thread.id);
      if (selectedThread?.id === updated.id) {
        setSelectedThread(updated);
      }
      await refreshThreads(
        selectedThread?.id === updated.id ? updated.id : undefined,
      );
    } catch {
      setThreadError("The local thread could not be updated.");
    }
  }

  async function unarchiveThread(threadId: string): Promise<void> {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    try {
      if (!appServerClient) return;
      const updated = await appServerClient.unarchiveThread(thread.id);
      if (selectedThread?.id === updated.id) {
        setSelectedThread(updated);
      }
      await refreshThreads(
        selectedThread?.id === updated.id ? updated.id : undefined,
      );
    } catch {
      setThreadError("The local thread could not be updated.");
    }
  }

  async function chooseWorkspace(): Promise<void> {
    setWorkspaceError(null);
    try {
      setSelection(await window.desktop.pickWorkspace());
    } catch {
      setWorkspaceError("The native workspace picker could not be opened.");
    }
  }

  async function grantWorkspace(): Promise<void> {
    if (!selection) return;
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
    }

    setWorkspace(granted);
    setSelection(null);
    if (granted.readiness === "ready") await refreshThreads();
  }

  async function revokeWorkspace(): Promise<void> {
    setWorkspaceError(null);
    try {
      if (!appServerClient) return;
      await appServerClient.revokeWorkspace();
      setWorkspace(null);
      setThreads([]);
      setSelectedThread(null);
      setThreadLoadState("ready");
    } catch {
      setWorkspaceError("The local workspace grant could not be revoked.");
    }
  }

  const sidebarModel = useMemo(
    () => projectThreadSidebar({
      state: threadLoadState === "error"
        ? { status: "error", message: "The local thread list could not be loaded." }
        : threadLoadState === "loading"
          ? { status: "loading" }
          : { status: "ready" },
      workspaces: workspace
        ? [{
            workspaceId: workspace.workspaceId,
            label: workspace.displayName,
            placement: "local",
          }]
        : [],
      threads: threads.map((thread) => ({
        selectionId: thread.id,
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        title: thread.title,
        updatedAt: thread.updatedAt,
        pinnedAt: thread.pinnedAt,
        archivedAt: thread.archivedAt,
        isUnread: false,
        displayStatus: "idle" satisfies ThreadSidebarDisplayStatus,
      })),
      selectedSelectionId: selectedThread?.id ?? null,
    }),
    [threadLoadState, workspace, threads, selectedThread?.id],
  );

  if (!build || !environment) {
    return <ClientShellLoading label="Loading Desktop" />;
  }

  return (
    <ClientShell
      environment={environment}
      onEnvironmentRetry={() => void window.desktop.restartEnvironment()}
    >
      <WorkspaceFrame
        className="desktop-workspace-frame"
        sidebarOpen={sidebarOpen}
        onSidebarOpenChange={setSidebarOpen}
        sidebar={(
          <ThreadSidebar
            model={sidebarModel}
            onSelect={(threadId) => {
              setSidebarOpen(false);
              void openThread(threadId);
            }}
            onCreate={workspace?.readiness === "ready"
              ? () => void createThread()
              : undefined}
            onArchive={archiveThread}
            onUnarchive={unarchiveThread}
          />
        )}
        topBar={(
          <WorkspaceTopBar
            title="LegionCode Desktop"
            actions={(
              <button type="button" onClick={() => void chooseWorkspace()}>
                Choose folder
              </button>
            )}
          />
        )}
      >
        <div className="desktop-content">
          <DesktopProviderSetup client={appServerClient} ready={sdkReady} />
          <section className="workspace-panel" aria-labelledby="workspace-heading">
            <div className="workspace-panel-header">
              <div>
                <p className="eyebrow">Local workspace</p>
                <h2 id="workspace-heading">
                  {workspace?.displayName ?? "No workspace granted"}
                </h2>
              </div>
            </div>
            {selection ? (
              <div className="workspace-selection">
                <p>Selected: {selection.displayName}</p>
                <button type="button" onClick={() => void grantWorkspace()}>
                  Grant access
                </button>
              </div>
            ) : null}
            {workspace && environment.status === "ready" ? (
              <dl className="workspace-details" aria-label="Workspace details">
                <div><dt>Repository</dt><dd>{workspace.repositoryIdentity ?? "Local Git repository"}</dd></div>
                <div><dt>Branch</dt><dd>{workspace.branch ?? "Detached HEAD"}</dd></div>
                <div><dt>Readiness</dt><dd>{workspace.readiness}</dd></div>
                <div><dt>Capabilities</dt><dd>{workspace.capabilities.join(", ") || "None"}</dd></div>
              </dl>
            ) : null}
            {workspace && environment.status === "ready" && workspace.readiness === "missing" ? <p role="status">{workspace.reason}</p> : null}
            {workspace && environment.status === "ready" ? <button type="button" onClick={() => void revokeWorkspace()}>Revoke access</button> : null}
            {workspaceError ? <p role="alert">{workspaceError}</p> : null}
          </section>

          {workspace?.readiness === "ready" ? (
            <section className="thread-panel" aria-labelledby="threads-heading">
              <div>
                <p className="eyebrow">Local threads</p>
                <h2 id="threads-heading">Threads</h2>
              </div>
              <div className="thread-create-row">
                <input
                  aria-label="New thread title"
                  value={newThreadTitle}
                  onChange={(event) => setNewThreadTitle(event.target.value)}
                  placeholder="New thread title"
                  maxLength={80}
                />
                <button type="button" onClick={() => void createThread(newThreadTitle)}>
                  Create thread
                </button>
              </div>
              {selectedThread ? (
                <div className="thread-detail" aria-label="Opened local thread">
                  <p className="eyebrow">Opened thread</p>
                  <input
                    aria-label="Thread title"
                    value={threadTitle}
                    onChange={(event) => setThreadTitle(event.target.value)}
                    maxLength={80}
                  />
                  <button type="button" onClick={() => void renameThread()}>
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => void setThreadArchived(selectedThread.status === "active")}
                  >
                    {selectedThread.status === "active" ? "Archive" : "Unarchive"}
                  </button>
                </div>
              ) : null}
              {threadError ? <p role="alert">{threadError}</p> : null}
            </section>
          ) : null}

          <dl className="desktop-build-info" aria-label="Build information">
            <div><dt>Version</dt><dd>{build.version}</dd></div>
            <div><dt>Platform</dt><dd>{build.platform}</dd></div>
            <div><dt>Architecture</dt><dd>{build.arch}</dd></div>
            <div><dt>Build</dt><dd>{build.packaged ? "Packaged" : "Development"}</dd></div>
          </dl>
        </div>
      </WorkspaceFrame>
    </ClientShell>
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
