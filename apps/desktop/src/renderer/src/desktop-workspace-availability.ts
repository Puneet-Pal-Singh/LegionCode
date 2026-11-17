import type { AppServerEnvironmentSnapshot, LocalWorkspaceGrant } from "@repo/platform-protocol";

/** Presentation of server capabilities; admission and grants remain server-owned. */
export function desktopWorkspaceAvailability(
  environment: AppServerEnvironmentSnapshot | null,
  workspace: LocalWorkspaceGrant | null,
  sdkReady: boolean,
) {
  const ready = sdkReady && environment?.kind === "local" && environment.status === "ready" &&
    workspace?.readiness === "ready";
  const hasGit = Boolean(ready && workspace.capabilities.includes("git"));
  const supports = (capability: string) => Boolean(ready && environment.capabilities.includes(capability));
  return {
    files: Boolean(ready && workspace.capabilities.includes("filesystem") && supports("workspace-files-v1")),
    gitReads: hasGit && supports("workspace-git-reads-v1"),
    review: hasGit && supports("artifact-review-v1"),
    commit: hasGit && supports("artifact-commit-v1"),
    // The current Native workspace manifest/capture contract requires Git.
    // Filesystem-only grants provide browsing until that runtime contract ships.
    execution: hasGit && supports("turn-execution-v1")
      ? { available: true as const }
      : { available: false as const, reason: ready && !hasGit
          ? workspace.reason ?? "Native tasks are unavailable for this folder."
          : "Local execution is unavailable in this environment." },
  };
}
