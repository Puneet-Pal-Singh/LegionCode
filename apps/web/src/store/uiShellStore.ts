/**
 * UI Shell Store
 * Manages workspace-level UI state: active run, workspace, session, and right panel.
 * Persists to localStorage for state recovery across reloads.
 */

export interface UIShellState {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  activeRunId: string | null;
  rightPanelTab: "files" | "changes" | "artifacts" | "terminal";
  leftPanelCollapsed: boolean;
  rightPanelOpen: boolean;
}

const STORAGE_KEY = "legioncode_ui_shell";
const DEFAULT_STATE: UIShellState = {
  activeWorkspaceId: null,
  activeSessionId: null,
  activeRunId: null,
  rightPanelTab: "files",
  leftPanelCollapsed: false,
  rightPanelOpen: false,
};

class UIShellStore {
  private state: UIShellState;
  private listeners: Array<(state: UIShellState) => void> = [];

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): UIShellState {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...DEFAULT_STATE, ...parsed };
      }
    } catch (e) {
      console.error("[uiShellStore] Failed to load state from localStorage:", e);
    }
    // Spread DEFAULT_STATE to avoid returning shared reference
    return { ...DEFAULT_STATE };
  }

  private saveState(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error("[uiShellStore] Failed to save state to localStorage:", e);
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener(this.state));
  }

  getState(): UIShellState {
    return this.state;
  }

  subscribe(listener: (state: UIShellState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  setActiveWorkspaceId(id: string | null): void {
    this.state = { ...this.state, activeWorkspaceId: id };
    this.saveState();
    this.notify();
  }

  setActiveSessionId(id: string | null): void {
    this.state = { ...this.state, activeSessionId: id };
    this.saveState();
    this.notify();
  }

  setActiveRunId(id: string | null): void {
    this.state = { ...this.state, activeRunId: id };
    this.saveState();
    this.notify();
  }

  setRightPanelTab(
    tab: "files" | "changes" | "artifacts" | "terminal",
  ): void {
    this.state = { ...this.state, rightPanelTab: tab };
    this.saveState();
    this.notify();
  }

  setLeftPanelCollapsed(collapsed: boolean): void {
    this.state = { ...this.state, leftPanelCollapsed: collapsed };
    this.saveState();
    this.notify();
  }

  setRightPanelOpen(open: boolean): void {
    this.state = { ...this.state, rightPanelOpen: open };
    this.saveState();
    this.notify();
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE };
    localStorage.removeItem(STORAGE_KEY);
    this.notify();
  }
}

export const uiShellStore = new UIShellStore();
