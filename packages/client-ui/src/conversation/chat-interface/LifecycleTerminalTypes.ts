export type LifecycleTerminalDisplayState =
  | "completed"
  | "failed_runtime"
  | "interrupted";

export interface LifecycleTerminalViewModel {
  id: string;
  state: LifecycleTerminalDisplayState;
  content: string;
  artifactId: string | null;
}
