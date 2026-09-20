import type { ReactNode } from "react";
import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";

import { EnvironmentStatus } from "../environment/EnvironmentStatus.js";

export function ClientShell({
  children,
  environment,
  onEnvironmentRetry,
}: {
  children: ReactNode;
  environment?: AppServerEnvironmentSnapshot;
  onEnvironmentRetry?: () => void;
}) {
  return (
    <div className="lc-client-shell">
      {environment ? (
        <EnvironmentStatus
          snapshot={environment}
          onRetry={onEnvironmentRetry}
        />
      ) : null}
      <div className="lc-client-shell-content">{children}</div>
    </div>
  );
}
