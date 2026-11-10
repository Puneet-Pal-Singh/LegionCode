import type { AppServerClient } from "@legioncode/sdk";
import type { WorkspaceId } from "@repo/platform-protocol";
import type { DiffContent, FileStatus, GitStatusReady } from "@repo/shared-types";
import { useEffect, useState } from "react";
import { DesktopReview, type DesktopReviewProps } from "./DesktopReview";
import {
  DesktopReviewPresentation,
  type DesktopReviewScopeControls,
} from "./DesktopReviewPresentation";

type LiveRead =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      git: GitStatusReady;
      selectedFile: FileStatus | null;
      diffs: { label: string; diff: DiffContent }[];
    };

/** Explicit workspace observations never replace or repair immutable saved Turn reads. */
export function DesktopWorkspaceReview({
  client,
  workspaceId,
  liveAvailable,
  saved,
  controls,
  scopeControls,
}: {
  client: Pick<AppServerClient, "getGitStatus" | "getGitDiff">;
  workspaceId: WorkspaceId;
  liveAvailable: boolean;
  saved: Omit<DesktopReviewProps, "controls" | "scopeControls">;
  controls: DesktopReviewProps["controls"];
  scopeControls: DesktopReviewScopeControls;
}) {
  if (scopeControls.value === "turn-diff")
    return <DesktopReview {...saved} controls={controls} scopeControls={scopeControls} />;
  if (!liveAvailable)
    return <DesktopReviewPresentation controls={controls} scopeControls={scopeControls} message="Live workspace Git changes are unavailable in this environment." />;
  return <LiveWorkspaceReview client={client} workspaceId={workspaceId} controls={controls} scopeControls={scopeControls} />;
}

function LiveWorkspaceReview({ client, workspaceId, controls, scopeControls }: {
  client: Pick<AppServerClient, "getGitStatus" | "getGitDiff">;
  workspaceId: WorkspaceId;
  controls: DesktopReviewProps["controls"];
  scopeControls: DesktopReviewScopeControls;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    client: typeof client;
    workspaceId: WorkspaceId;
    requestedPath: string | null;
    value: LiveRead;
  } | null>(null);
  const read: LiveRead = result?.client === client && result.workspaceId === workspaceId && result.requestedPath === selectedPath
    ? result.value : { status: "loading" };
  const visible = controls.isReviewVisible !== false;
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (!active || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const git = await client.getGitStatus({ workspaceId });
        if (!active) return;
        if (!git.gitAvailable) throw new Error("Workspace is not a Git repository.");
        const selectedFile = git.files.find((file) => file.path === selectedPath) ?? git.files[0] ?? null;
        const diffs: { label: string; diff: DiffContent }[] = [];
        if (selectedFile) {
          const unstaged = await client.getGitDiff({ workspaceId, path: selectedFile.path, staged: false });
          if (!active) return;
          if (unstaged.hunks.length || unstaged.isBinary || unstaged.isNewFile || unstaged.isDeleted)
            diffs.push({ label: "Unstaged changes", diff: unstaged });
          if (selectedFile.isStaged) {
            const staged = await client.getGitDiff({ workspaceId, path: selectedFile.path, staged: true });
            if (!active) return;
            if (staged.hunks.length || staged.isBinary || staged.isNewFile || staged.isDeleted)
              diffs.push({ label: "Staged changes", diff: staged });
          }
        }
        setResult({ client, workspaceId, requestedPath: selectedPath, value: { status: "ready", git, selectedFile, diffs } });
      } catch {
        if (active) setResult({ client, workspaceId, requestedPath: selectedPath, value: { status: "error" } });
      } finally {
        inFlight = false;
      }
    };
    const onRefresh = () => { void refresh(); };
    onRefresh();
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    const interval = window.setInterval(onRefresh, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
    };
  }, [client, workspaceId, selectedPath, revision, visible]);
  const ready = read.status === "ready" ? read : null;
  return (
    <DesktopReviewPresentation
      controls={controls}
      scopeControls={scopeControls}
      files={ready?.git.files}
      selectedFile={ready?.selectedFile}
      onSelectFile={(file) => setSelectedPath(file.path)}
      diffSections={ready?.diffs.length ? ready.diffs : undefined}
      branch={ready?.git.branch}
      message={read.status === "loading"
        ? "Loading live workspace changes…"
        : read.status === "error" ? "Live workspace changes could not be loaded." : undefined}
      error={read.status === "error"}
      onRetry={read.status === "error" ? () => { setResult(null); setRevision((value) => value + 1); } : undefined}
      emptyLabel="No live workspace changes."
      missingDiffLabel="No patch content is available for this file."
    />
  );
}
