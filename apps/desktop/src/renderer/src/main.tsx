import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { DesktopBuildInfo } from "../../shared/desktop-api";
import "./styles.css";

function DesktopHello(): React.JSX.Element {
  const [build, setBuild] = useState<DesktopBuildInfo | null>(null);

  useEffect(() => {
    void window.desktop.getBuildInfo().then(setBuild);
  }, []);

  return (
    <main>
      <p className="eyebrow">Local-first coding workspace</p>
      <h1>Hello from LegionCode Desktop</h1>
      {build ? (
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
      ) : (
        <p role="status">Loading build information…</p>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Desktop renderer root is missing");
}

createRoot(root).render(
  <StrictMode>
    <DesktopHello />
  </StrictMode>,
);
