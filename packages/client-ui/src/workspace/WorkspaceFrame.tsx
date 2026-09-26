import { useState, type ReactNode } from "react";

export interface WorkspaceFrameProps {
  sidebar: ReactNode;
  topBar: ReactNode;
  children: ReactNode;
  className?: string;
  sidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
}

/** Responsive shared application frame. Platform entries supply the content slots. */
export function WorkspaceFrame({
  sidebar,
  topBar,
  children,
  className,
  sidebarOpen,
  onSidebarOpenChange,
}: WorkspaceFrameProps): React.ReactElement {
  const [internalSidebarOpen, setInternalSidebarOpen] = useState(false);
  const isSidebarOpen = sidebarOpen ?? internalSidebarOpen;
  const setSidebarOpen = (open: boolean): void => {
    setInternalSidebarOpen(open);
    onSidebarOpenChange?.(open);
  };

  return (
    <div className={`lc-workspace-frame${className ? ` ${className}` : ""}`}>
      <div
        className={`lc-workspace-sidebar${isSidebarOpen ? " lc-workspace-sidebar-open" : ""}`}
        data-testid="workspace-sidebar"
      >
        {sidebar}
      </div>
      {isSidebarOpen ? (
        <button
          className="lc-workspace-sidebar-backdrop"
          type="button"
          aria-label="Close workspace navigation"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <div className="lc-workspace-main">
        <div className="lc-workspace-topbar">
          <button
            className="lc-workspace-menu-button"
            type="button"
            aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
            aria-expanded={isSidebarOpen}
            onClick={() => setSidebarOpen(!isSidebarOpen)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          {topBar}
        </div>
        <main className="lc-workspace-content">{children}</main>
      </div>
    </div>
  );
}
