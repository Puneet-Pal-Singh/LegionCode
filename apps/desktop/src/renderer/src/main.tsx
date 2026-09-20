import {
  ClientErrorBoundary,
  ClientShell,
  ClientShellLoading,
} from "@legioncode/client-ui";
import "@legioncode/client-ui/styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";
import type { LocalWorkspaceGrant } from "@repo/platform-protocol";

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
      .then(setWorkspace)
      .catch(() => setWorkspaceError("The local workspace grant could not be loaded."));
  }, [environment?.status]);

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
