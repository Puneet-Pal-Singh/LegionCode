import type {
  LifecycleEvent,
  TurnTerminalStatus,
} from "@repo/platform-protocol/lifecycle";

export type GoldenChangedFileStatus = "created" | "modified" | "deleted";

export interface GoldenChangedFile {
  readonly path: string;
  readonly status: GoldenChangedFileStatus;
}

export interface GoldenLifecycleScenario {
  readonly name: string;
  readonly events: readonly LifecycleEvent[];
  readonly terminalStatus: TurnTerminalStatus;
  readonly changedFiles: readonly GoldenChangedFile[];
  readonly cursors: readonly number[];
  readonly reloadAfterCompletion?: boolean;
}

export interface GoldenIllegalLifecycleScenario {
  readonly name: string;
  readonly events: readonly LifecycleEvent[];
}

export interface GoldenMalformedLifecycleScenario {
  readonly name: string;
  readonly event: unknown;
}

export interface GoldenIsolationScenario {
  readonly name: string;
  readonly left: GoldenLifecycleScenario;
  readonly right: GoldenLifecycleScenario;
  readonly mixedEvents: readonly LifecycleEvent[];
}

export interface GoldenLifecycleMatrix {
  readonly legal: readonly GoldenLifecycleScenario[];
  readonly illegal: readonly GoldenIllegalLifecycleScenario[];
  readonly malformed: readonly GoldenMalformedLifecycleScenario[];
  readonly isolation: GoldenIsolationScenario;
}
