import type { LifecycleProjection } from "@legioncode/sdk";

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
  return null;
}

export function workspaceSnapshotNotice(
  projection: LifecycleProjection,
): string | null {
  if (projection.terminal?.state !== "interrupted") return null;
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
    default:
      return "The workspace is available for review, but this turn cannot be resumed.";
  }
}
