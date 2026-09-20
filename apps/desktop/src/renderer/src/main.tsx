import {
  ClientErrorBoundary,
  ClientShell,
  ClientShellLoading,
} from "@legioncode/client-ui";
import "@legioncode/client-ui/styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";
import type { LocalWorkspaceGrant, Thread } from "@repo/platform-protocol";

import type {
  DesktopBuildInfo,
  WorkspaceSelection,
} from "../../shared/desktop-api";
import "./styles.css";

function DesktopApp(): React.JSX.Element {
  const [build, setBuild] = useState<DesktopBuildInfo | null>(null);
  const [environment, setEnvironment] =
    useState<AppServerEnvironmentSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<LocalWorkspaceGrant | null>(null);
  const [selection, setSelection] = useState<WorkspaceSelection | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [threadTitle, setThreadTitle] = useState("");
  const [threadError, setThreadError] = useState<string | null>(null);

  useEffect(() => {
    void window.desktop.getBuildInfo().then(setBuild);
    void window.desktop.getEnvironment().then(setEnvironment);
    return window.desktop.onEnvironmentStatus(setEnvironment);
  }, []);

  useEffect(() => {
    if (environment?.status !== "ready") {
      return;
    }
    void window.desktop
      .getWorkspace()
      .then(async (nextWorkspace) => {
        setWorkspace(nextWorkspace);
        if (nextWorkspace?.readiness === "ready") {
          setThreads(await window.desktop.listThreads());
        } else {
          setThreads([]);
          setSelectedThread(null);
        }
      })
      .catch(() => setWorkspaceError("The local workspace grant could not be loaded."));
  }, [environment?.status]);

  async function refreshThreads(): Promise<void> {
    const nextThreads = await window.desktop.listThreads();
    setThreads(nextThreads);
    if (selectedThread) {
      const nextSelected = nextThreads.find((thread) => thread.id === selectedThread.id) ?? null;
      setSelectedThread(nextSelected);
      setThreadTitle(nextSelected?.title ?? "");
    }
  }

  async function createThread(): Promise<void> {
    setThreadError(null);
    try {
      const created = await window.desktop.createThread(newThreadTitle.trim() || undefined);
      setNewThreadTitle("");
      setSelectedThread(created);
      setThreadTitle(created.title);
      await refreshThreads();
    } catch {
      setThreadError("The local thread could not be created.");
    }
  }

  async function openThread(threadId: Thread["id"]): Promise<void> {
    setThreadError(null);
    try {
      const opened = await window.desktop.getThread(threadId);
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
      const renamed = await window.desktop.renameThread(selectedThread.id, threadTitle);
      setSelectedThread(renamed);
      await refreshThreads();
    } catch {
      setThreadError("Thread titles must contain 1 to 80 characters.");
    }
  }

  async function setThreadArchived(archived: boolean): Promise<void> {
    if (!selectedThread) return;
    setThreadError(null);
    try {
      const updated = archived
        ? await window.desktop.archiveThread(selectedThread.id)
        : await window.desktop.unarchiveThread(selectedThread.id);
      setSelectedThread(updated);
      await refreshThreads();
    } catch {
      setThreadError("The local thread could not be updated.");
    }
  }

  async function chooseWorkspace(): Promise<void> {
    setWorkspaceError(null);
    try {
      const nextSelection = await window.desktop.pickWorkspace();
      setSelection(nextSelection);
    } catch {
      setWorkspaceError("The native workspace picker could not be opened.");
    }
  }

  async function grantWorkspace(): Promise<void> {
    if (!selection) return;
    setWorkspaceError(null);
    try {
      setWorkspace(await window.desktop.grantWorkspace(selection.selectionToken));
      setSelection(null);
    } catch {
      setWorkspaceError("The selected directory is not a Git repository root.");
    }
  }

  async function revokeWorkspace(): Promise<void> {
    setWorkspaceError(null);
    try {
      await window.desktop.revokeWorkspace();
      setWorkspace(null);
      setThreads([]);
      setSelectedThread(null);
    } catch {
      setWorkspaceError("The local workspace grant could not be revoked.");
    }
  }

  if (!build || !environment) {
    return <ClientShellLoading label="Loading Desktop" />;
  }

  return (
    <ClientShell
      environment={environment}
      onEnvironmentRetry={() => void window.desktop.restartEnvironment()}
    >
      <main className="desktop-welcome">
        <p className="eyebrow">Local-first coding workspace</p>
        <h1>LegionCode Desktop</h1>
        <p className="desktop-summary">
          Choose a local Git workspace to keep your files and execution on this
          device. No cloud account is required.
        </p>
        <section className="workspace-panel" aria-labelledby="workspace-heading">
          <div className="workspace-panel-header">
            <div>
              <p className="eyebrow">Local workspace</p>
              <h2 id="workspace-heading">
                {workspace?.displayName ?? "No workspace granted"}
              </h2>
            </div>
            <button type="button" onClick={() => void chooseWorkspace()}>
              Choose folder
            </button>
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
            <div className="workspace-panel-header">
              <div>
                <p className="eyebrow">Local threads</p>
                <h2 id="threads-heading">Threads</h2>
              </div>
              <span className="local-only-badge">Local only</span>
            </div>
            <div className="thread-create-row">
              <input
                aria-label="New thread title"
                value={newThreadTitle}
                onChange={(event) => setNewThreadTitle(event.target.value)}
                placeholder="New thread title"
                maxLength={80}
              />
              <button type="button" onClick={() => void createThread()}>
                Create thread
              </button>
            </div>
            {threads.length ? (
              <ul aria-label="Local thread list" className="thread-list">
                {threads.map((thread) => (
                  <li key={thread.id} className={thread.id === selectedThread?.id ? "selected" : ""}>
                    <button type="button" onClick={() => void openThread(thread.id)}>
                      {thread.title}
                    </button>
                    <span>{thread.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No local threads yet.</p>
            )}
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
        <dl aria-label="Build information">
          <div>
            <dt>Version</dt>
            <dd>{build.version}</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd>{build.platform}</dd>
          </div>
          <div>
            <dt>Architecture</dt>
            <dd>{build.arch}</dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>{build.packaged ? "Packaged" : "Development"}</dd>
          </div>
        </dl>
      </main>
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
