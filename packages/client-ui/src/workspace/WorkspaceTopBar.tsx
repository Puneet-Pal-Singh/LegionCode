import type { ReactNode } from "react";

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
  return (
    <header className="lc-workspace-topbar-content">
      {leading ? <div className="lc-workspace-topbar-leading">{leading}</div> : null}
      {title ? <h1 className="lc-workspace-topbar-title">{title}</h1> : null}
      <div className="lc-workspace-topbar-spacer" />
      {actions ? <div className="lc-workspace-topbar-actions">{actions}</div> : null}
    </header>
  );
}
