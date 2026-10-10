import type {
  LifecycleProjection,
  LifecycleProjectionTerminalState,
} from "@legioncode/sdk";
import type {
  LifecycleTerminalDisplayState,
  LifecycleTerminalViewModel,
} from "./LifecycleTerminalTypes.js";

export function buildLifecycleTerminalViewModel(
  projection: LifecycleProjection | null,
): LifecycleTerminalViewModel | null {
  if (!projection?.terminal) {
    return null;
  }
  return {
    id: `terminal:${projection.turnId}`,
    state: mapTerminalState(projection.terminal.state),
    content:
      projection.terminal.state === "completed"
        ? projection.assistantText || projection.terminal.content
        : projection.terminal.content,
    artifactId: null,
  };
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
