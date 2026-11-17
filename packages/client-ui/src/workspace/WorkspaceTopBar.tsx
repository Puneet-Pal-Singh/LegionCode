import type { ReactNode } from "react";
import { useWorkspaceSummaryLayout } from "./WorkspaceSummaryLayout.js";

export interface WorkspaceTopBarProps {
  title?: string;
  leading?: ReactNode;
  actions?: ReactNode;
}

export function WorkspaceTopBar({
  title,
  leading,
  actions,
}: WorkspaceTopBarProps): React.ReactElement {
  const summaryLayout = useWorkspaceSummaryLayout();
  return (
    <header
      className="lc-workspace-topbar-content"
      style={summaryLayout?.headerInset ? { marginRight: summaryLayout.headerInset } : undefined}
    >
      {title ? <h1 className="lc-workspace-topbar-title">{title}</h1> : null}
      {leading ? <div className="lc-workspace-topbar-leading">{leading}</div> : null}
      <div className="lc-workspace-topbar-spacer" />
      {actions ? <div className="lc-workspace-topbar-actions shrink-0">{actions}</div> : null}
    </header>
  );
}
