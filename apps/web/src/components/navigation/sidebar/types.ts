export type SidebarTaskStatus =
  | "idle"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "needs_approval";

export interface SidebarTaskMetrics {
  added?: number;
  removed?: number;
  unreadCount?: number;
  label?: string;
}

export interface SidebarTaskItem {
  id: string;
  title: string;
  status: SidebarTaskStatus;
  updatedAt: string;
  isActive: boolean;
  context?: string;
  metrics?: SidebarTaskMetrics;
}
