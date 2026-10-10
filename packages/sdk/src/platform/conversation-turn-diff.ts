import type { FileStatus } from "@repo/shared-types";
import type { LifecycleProjection } from "../workflow/conversation-lifecycle-projection.js";

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
