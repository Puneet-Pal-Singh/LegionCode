import { useEffect, useRef, useState } from "react";
import { bootstrapGitWorkspace } from "../../../lib/git-workspace-bootstrap";
import { subscribeRuntimeBootChanges } from "../../../lib/runtime-boot-monitor";

interface UseBootstrapProps {
  sessionId: string;
  activeRunId: string;
  gitAvailable: boolean | undefined;
  isRunLoading: boolean;
  isContextMismatch: boolean;
  isGitHubLoaded: boolean;
  repositoryOwner: string;
  repositoryName: string;
  repositoryBranch: string;
  repositoryBaseUrl: string | undefined;
  refetchGitStatus: (force?: boolean) => Promise<unknown>;
}

interface RunBootstrapArgs {
  bootstrapKey: string;
  shouldRecover: boolean;
  args: UseBootstrapProps;
}

export function useBootstrap({
  sessionId,
  activeRunId,
  gitAvailable,
  isRunLoading,
  isContextMismatch,
  isGitHubLoaded,
  repositoryOwner,
  repositoryName,
  repositoryBranch,
  repositoryBaseUrl,
  refetchGitStatus,
}: UseBootstrapProps): boolean {
  const [isGitWorkspaceRecovering, setIsGitWorkspaceRecovering] =
    useState(false);
  const bootstrapKeyRef = useRef<string | null>(null);
  const inFlightRef = useRef<string | null>(null);
  const recoveryKeyRef = useRef<string | null>(null);

  useEffect(() => {
    return subscribeRuntimeBootChanges(() => {
      bootstrapKeyRef.current = null;
      recoveryKeyRef.current = null;
      void refetchGitStatus(true);
    });
  }, [refetchGitStatus]);

  useEffect(() => {
    if (!sessionId || !activeRunId) return;
    if (isRunLoading || !isGitHubLoaded || isContextMismatch) return;
    if (!repositoryOwner || !repositoryName) return;
    const bootstrapKey = `${sessionId}:${activeRunId}:${repositoryOwner}/${repositoryName}:${repositoryBranch}`;
    const shouldRecover = gitAvailable === false;
    if (
      isAlreadyHandled(
        bootstrapKey,
        shouldRecover,
        bootstrapKeyRef,
        inFlightRef,
        recoveryKeyRef,
      )
    ) {
      return;
    }
    inFlightRef.current = bootstrapKey;
    if (shouldRecover) {
      recoveryKeyRef.current = bootstrapKey;
      setIsGitWorkspaceRecovering(true);
    }
    void runWorkspaceBootstrap({
      bootstrapKey,
      shouldRecover,
      args: {
        sessionId,
        activeRunId,
        gitAvailable,
        isRunLoading,
        isContextMismatch,
        isGitHubLoaded,
        repositoryOwner,
        repositoryName,
        repositoryBranch,
        repositoryBaseUrl,
        refetchGitStatus,
      },
      bootstrapKeyRef,
      inFlightRef,
      recoveryKeyRef,
      onRecoveryStateChange: setIsGitWorkspaceRecovering,
    });
  }, [
    activeRunId,
    gitAvailable,
    isRunLoading,
    isContextMismatch,
    isGitHubLoaded,
    refetchGitStatus,
    repositoryBaseUrl,
    repositoryBranch,
    repositoryName,
    repositoryOwner,
    sessionId,
  ]);

  return isGitWorkspaceRecovering;
}

function isAlreadyHandled(
  bootstrapKey: string,
  shouldRecover: boolean,
  bootstrapKeyRef: React.MutableRefObject<string | null>,
  inFlightRef: React.MutableRefObject<string | null>,
  recoveryKeyRef: React.MutableRefObject<string | null>,
): boolean {
  if (!shouldRecover && bootstrapKeyRef.current === bootstrapKey) return true;
  if (inFlightRef.current === bootstrapKey) return true;
  if (shouldRecover && recoveryKeyRef.current === bootstrapKey) return true;
  return false;
}

async function runWorkspaceBootstrap({
  bootstrapKey,
  shouldRecover,
  args,
  bootstrapKeyRef,
  inFlightRef,
  recoveryKeyRef,
  onRecoveryStateChange,
}: RunBootstrapArgs & {
  bootstrapKeyRef: React.MutableRefObject<string | null>;
  inFlightRef: React.MutableRefObject<string | null>;
  recoveryKeyRef: React.MutableRefObject<string | null>;
  onRecoveryStateChange: (recovering: boolean) => void;
}): Promise<void> {
  let bootstrapReady = false;
  try {
    const result = await bootstrapGitWorkspace({
      runId: args.activeRunId,
      sessionId: args.sessionId,
      repositoryOwner: args.repositoryOwner,
      repositoryName: args.repositoryName,
      repositoryBranch: args.repositoryBranch,
      repositoryBaseUrl: args.repositoryBaseUrl,
    });
    if (result.status === "ready") {
      bootstrapReady = true;
      bootstrapKeyRef.current = bootstrapKey;
      recoveryKeyRef.current = null;
    }
    if (result.status !== "ready" && result.message) {
      const log =
        result.status === "sync-failed" ? console.debug : console.warn;
      log(`[workspace/git-bootstrap] ${result.status}: ${result.message}`);
    }
  } catch (error) {
    console.warn("[workspace/git-bootstrap] failed", error);
  } finally {
    if (inFlightRef.current === bootstrapKey) inFlightRef.current = null;
    if (bootstrapReady) await args.refetchGitStatus(true);
    if (shouldRecover) onRecoveryStateChange(false);
  }
}
