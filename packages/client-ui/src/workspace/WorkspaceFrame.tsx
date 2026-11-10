import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { shouldIgnoreGlobalKeyDown } from "../hooks/global-keydown.js";
import { getVisibleFocusTargets } from "../hooks/modal-focus.js";

const COMPACT_WORKSPACE_QUERY = "(max-width: 1023px)";

export interface WorkspaceFrameProps {
  sidebar: ReactNode;
  topBar: ReactNode;
  children: ReactNode;
  rightPanel?: ReactNode;
  rightPanelLabel?: string;
  rightPanelWidth?: number;
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
  rightPanel,
  rightPanelLabel = "Workspace details",
  rightPanelWidth,
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
      const sidebarElement = sidebarRef.current;
      if (sidebarElement) (getVisibleFocusTargets(sidebarElement)[0] ?? sidebarElement).focus();
    } else if (previous.isSidebarOpen && !isSidebarOpen && previous.isCompact) {
      menuButtonRef.current?.focus();
    }
  }, [isCompact, isSidebarOpen]);

  useEffect(() => {
    if (!isCompact || !isSidebarOpen) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (shouldIgnoreGlobalKeyDown(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }

      if (event.key !== "Tab") return;
      const sidebarElement = sidebarRef.current;
      if (!sidebarElement) return;

      // Thread details/rename are portaled, but their owning row already names
      // the dialog through aria-describedby. Keep those controls in this drawer.
      const ownedDialogs = Array.from(sidebarElement.querySelectorAll<HTMLElement>("[aria-describedby]"))
        .flatMap((element) => (element.getAttribute("aria-describedby") ?? "").split(/\s+/))
        .map((id) => document.getElementById(id))
        .filter((element): element is HTMLElement => Boolean(element?.getAttribute("role") === "dialog"));
      const focusRoots = [sidebarElement, ...ownedDialogs];
      const focusable = focusRoots.flatMap(getVisibleFocusTargets);
      if (focusable.length === 0) {
        event.preventDefault();
        sidebarElement.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      const isOwnedFocus = focusRoots.some((element) => element.contains(activeElement));
      if (event.shiftKey && (activeElement === first || !isOwnedFocus)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !isOwnedFocus)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isCompact, isSidebarOpen]);

  const isModalOpen = isCompact && isSidebarOpen;
  const panelStyle: (CSSProperties & { "--lc-workspace-panel-width"?: string }) | undefined =
    rightPanelWidth === undefined ? undefined : { "--lc-workspace-panel-width": `${rightPanelWidth}px` };

  return (
    <div className={`lc-workspace-frame${className ? ` ${className}` : ""}`} style={panelStyle}>
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
          {!isSidebarOpen ? (
            <button
              ref={menuButtonRef}
              className="lc-workspace-menu-button rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
              type="button"
              aria-label="Open sidebar"
              aria-expanded={false}
              title="Open sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen size={16} aria-hidden="true" />
            </button>
          ) : null}
          {topBar}
        </div>
        <div className={`lc-workspace-body${rightPanel ? " lc-workspace-body-with-panel" : ""}`}>
          <main className="lc-workspace-content">{children}</main>
          {rightPanel ? (
            <aside className="lc-workspace-right-panel" aria-label={rightPanelLabel}>{rightPanel}</aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
