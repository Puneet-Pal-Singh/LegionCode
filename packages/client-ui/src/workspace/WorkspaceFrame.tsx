import { useEffect, useRef, useState, type ReactNode } from "react";

const COMPACT_WORKSPACE_QUERY = "(max-width: 1023px)";
const SIDEBAR_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface WorkspaceFrameProps {
  sidebar: ReactNode;
  topBar: ReactNode;
  children: ReactNode;
  className?: string;
  sidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
}

function useCompactWorkspaceLayout(): boolean {
  const [isCompact, setIsCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia(COMPACT_WORKSPACE_QUERY).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_WORKSPACE_QUERY);
    const update = (): void => setIsCompact(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isCompact;
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
  const isCompact = useCompactWorkspaceLayout();
  const sidebarRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousState = useRef({ isSidebarOpen, isCompact });
  const setSidebarOpen = (open: boolean): void => {
    setInternalSidebarOpen(open);
    onSidebarOpenChange?.(open);
  };

  useEffect(() => {
    const previous = previousState.current;
    previousState.current = { isSidebarOpen, isCompact };

    if (previous.isSidebarOpen === isSidebarOpen) return;
    if (!previous.isSidebarOpen && isSidebarOpen && isCompact) {
      sidebarRef.current?.querySelector<HTMLElement>(SIDEBAR_FOCUSABLE_SELECTOR)?.focus();
    } else if (previous.isSidebarOpen && !isSidebarOpen && previous.isCompact) {
      menuButtonRef.current?.focus();
    }
  }, [isCompact, isSidebarOpen]);

  useEffect(() => {
    if (!isCompact || !isSidebarOpen) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }

      if (event.key !== "Tab") return;
      const sidebarElement = sidebarRef.current;
      if (!sidebarElement) return;

      const focusable = Array.from(
        sidebarElement.querySelectorAll<HTMLElement>(SIDEBAR_FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        sidebarElement.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !sidebarElement.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !sidebarElement.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isCompact, isSidebarOpen]);

  const isModalOpen = isCompact && isSidebarOpen;

  return (
    <div className={`lc-workspace-frame${className ? ` ${className}` : ""}`}>
      <div
        ref={sidebarRef}
        className={`lc-workspace-sidebar${isSidebarOpen ? " lc-workspace-sidebar-open" : ""}`}
        data-testid="workspace-sidebar"
        role={isModalOpen ? "dialog" : undefined}
        aria-label={isModalOpen ? "Workspace navigation" : undefined}
        aria-modal={isModalOpen ? true : undefined}
        tabIndex={isModalOpen ? -1 : undefined}
      >
        {sidebar}
      </div>
      {isModalOpen ? (
        <button
          className="lc-workspace-sidebar-backdrop"
          type="button"
          tabIndex={-1}
          aria-label="Close workspace navigation"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <div className="lc-workspace-main" inert={isModalOpen}>
        <div className="lc-workspace-topbar">
          <button
            ref={menuButtonRef}
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
