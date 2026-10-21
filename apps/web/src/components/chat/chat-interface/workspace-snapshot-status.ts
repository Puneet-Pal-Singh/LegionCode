import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection.js";

export function workspaceSnapshotNotice(
  projection: LifecycleProjection,
): string | null {
  if (projection.executionCapability === "conversation" || projection.terminal?.state !== "interrupted") return null;
  if (projection.workspaceSnapshotState === "unavailable") {
    return describeWorkspaceSnapshotUnavailable(
      projection.workspaceSnapshotUnavailableReason,
    );
  }
  if (
    projection.workspaceSnapshotState === "captured" &&
    projection.resumeSnapshotAvailable !== true
  ) {
    return describeResumeUnavailable(projection.resumeUnavailableReason);
  }
  return null;
}

function describeWorkspaceSnapshotUnavailable(reason: string | null): string {
  switch (reason) {
    case "worker_not_quiescent":
      return "The workspace was still changing when this turn stopped. Review and Play are unavailable.";
    case "snapshot_too_large":
      return "The final workspace snapshot was too large to save. Review and Play are unavailable.";
    default:
      return "The final workspace state could not be captured. Review and Play are unavailable.";
  }
}

function describeResumeUnavailable(reason: string | null): string {
  switch (reason) {
    case "worker_not_quiescent":
      return "The workspace was still changing when this turn stopped, so it cannot be resumed.";
    case "snapshot_too_large":
      return "The resume snapshot was too large to save, so this turn cannot be resumed.";
    case "snapshot_unavailable":
      return "No resume snapshot was saved for this turn. You can review the workspace or send a new message.";
    default:
      return "No resume snapshot was saved for this turn. You can review the workspace or send a new message.";
  }
}
