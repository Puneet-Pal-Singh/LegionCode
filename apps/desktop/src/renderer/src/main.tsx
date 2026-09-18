import {
  ClientErrorBoundary,
  ClientShell,
  ClientShellLoading,
} from "@legioncode/client-ui";
import "@legioncode/client-ui/styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { DesktopBuildInfo } from "../../shared/desktop-api";
import "./styles.css";

function DesktopApp(): React.JSX.Element {
  const [build, setBuild] = useState<DesktopBuildInfo | null>(null);

  useEffect(() => {
    void window.desktop.getBuildInfo().then(setBuild);
  }, []);

  if (!build) {
    return <ClientShellLoading label="Loading Desktop" />;
  }

  return (
    <ClientShell>
      <main className="desktop-welcome">
        <p className="eyebrow">Local-first coding workspace</p>
        <h1>LegionCode Desktop</h1>
        <p className="desktop-summary">
          The native shell is ready for a local workspace.
        </p>
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
