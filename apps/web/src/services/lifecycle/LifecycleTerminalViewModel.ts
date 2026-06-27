import type { FileStatus } from "@repo/shared-types";
import type {
  LifecycleProjection,
  LifecycleProjectionTerminalState,
} from "./LifecycleProjection";
import type {
  LifecycleTerminalDisplayState,
  LifecycleTerminalViewModel,
} from "./LifecycleTerminalTypes";

export function buildLifecycleTerminalViewModel(
  projection: LifecycleProjection | null,
): LifecycleTerminalViewModel | null {
  if (!projection?.terminal) {
    return null;
  }
  if (projection.terminal.state === "completed" && projection.assistantText) {
    return null;
  }
  return {
    id: `terminal:${projection.turnId}`,
    state: mapTerminalState(projection.terminal.state),
    content: projection.terminal.content,
    artifactId: null,
  };
}

export function collectLifecycleTurnDiffFiles(
  projection: LifecycleProjection | null,
): FileStatus[] {
  return (projection?.turnDiff?.files ?? []).map((file) => ({
    path: file.path,
    status:
      file.status === "unchanged" || file.status === "copied"
        ? "modified"
        : file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    isStaged: false,
  }));
}

function mapTerminalState(
  state: LifecycleProjectionTerminalState,
): LifecycleTerminalDisplayState {
  switch (state) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed_runtime";
  }
}
