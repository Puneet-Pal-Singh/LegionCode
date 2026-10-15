import type { LifecycleProjection } from "../../../services/lifecycle/LifecycleProjection.js";

export function resumeUnavailableMessage(
  projection: LifecycleProjection | null,
  hasScope: boolean,
): string | null {
  if (!hasScope || projection?.terminal?.state !== "interrupted") return null;
  if (projection.workspaceSnapshotState === "unavailable") {
    return describeWorkspaceSnapshotUnavailable(
      projection.workspaceSnapshotUnavailableReason,
    );
  }
  if (projection.workspaceSnapshotState === "captured") {
    if (projection.resumeSnapshotAvailable === true) return null;
    return describeResumeUnavailable(projection.resumeUnavailableReason);
  }
  return "The final workspace snapshot is not available yet, so this turn cannot be resumed safely.";
}

export function workspaceSnapshotNotice(
  projection: LifecycleProjection,
): string | null {
  if (projection.workspaceSnapshotState === "unavailable") {
    return describeWorkspaceSnapshotUnavailable(
      projection.workspaceSnapshotUnavailableReason,
    );
  }
  if (
    projection.workspaceSnapshotState === "captured" &&
    projection.resumeSnapshotAvailable !== true
  ) {
    return `${describeResumeUnavailable(projection.resumeUnavailableReason)} Workspace review remains available.`;
  }
  return null;
}

function describeWorkspaceSnapshotUnavailable(reason: string | null): string {
  switch (reason) {
    case "worker_not_quiescent":
      return "The workspace may still be changing. Review and Play are unavailable until its final state can be verified.";
    case "snapshot_too_large":
      return "The final workspace snapshot was too large to capture. Review and Play are unavailable.";
    default:
      return "The final workspace state could not be captured. Review and Play are unavailable.";
  }
}

function describeResumeUnavailable(reason: string | null): string {
  switch (reason) {
    case "worker_not_quiescent":
      return "The workspace may still be changing, so this turn cannot be resumed safely.";
    case "snapshot_too_large":
      return "The saved resume snapshot was too large to preserve. This turn cannot be resumed.";
    default:
      return "The final workspace is available for review, but its saved resume snapshot is unavailable.";
  }
}
