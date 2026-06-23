import type { FileStatus } from "@repo/shared-types";
import type { RunTerminalViewModel } from "../workflow/RunTerminalViewModel";
import type {
  LifecycleProjection,
  LifecycleProjectionTerminalState,
} from "./LifecycleProjection";

export function buildLifecycleTerminalViewModel(
  projection: LifecycleProjection | null,
): RunTerminalViewModel | null {
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
): RunTerminalViewModel["state"] {
  switch (state) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed_runtime";
  }
}
