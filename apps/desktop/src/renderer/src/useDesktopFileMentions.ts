import type { AppServerClient } from "@legioncode/sdk";
import type { LocalWorkspaceGrant } from "@repo/platform-protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type DesktopFileMentionsClient = Pick<
  AppServerClient,
  "listWorkspaceFileMentions"
>;
interface Options {
  client: DesktopFileMentionsClient;
  workspace: Pick<
    LocalWorkspaceGrant,
    "workspaceId" | "grantedAt" | "readiness"
  > | null;
  availability: { available: true } | { available: false; reason: string };
  /** Current mention's folder prefix, derived by the shared mention parser. */
  directory?: string;
  /** The caller can refresh after an authoritative workspace-change receipt. */
  revision?: number;
}
type Scope = {
  client: DesktopFileMentionsClient;
  workspaceId: LocalWorkspaceGrant["workspaceId"] | null;
  grantedAt: string | null;
  readiness: LocalWorkspaceGrant["readiness"] | null;
  available: boolean;
  directory: string;
  revision: number;
};
type Read = {
  scope: Scope;
  files: string[];
  error: string | null;
  notice?: string | null;
};

/** Filename presentation only. The SDK/native read owner retains all root access. */
export function useDesktopFileMentions({
  client,
  workspace,
  availability,
  directory = ".",
  revision = 0,
}: Options) {
  const [retry, setRetry] = useState(0);
  const scope = useMemo<Scope>(
    () => ({
      client,
      workspaceId: workspace?.workspaceId ?? null,
      grantedAt: workspace?.grantedAt ?? null,
      readiness: workspace?.readiness ?? null,
      available: availability.available,
      directory,
      revision,
    }),
    [
      client,
      workspace?.workspaceId,
      workspace?.grantedAt,
      workspace?.readiness,
      availability.available,
      directory,
      revision,
      retry,
    ],
  );
  const activeScope = useRef<Scope | null>(scope);
  const inFlight = useRef<Promise<unknown> | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
    };
  }, [scope]);

  useEffect(() => {
    let active = true;
    if (!scope.available || !scope.workspaceId || scope.readiness !== "ready")
      return;
    const timer = setTimeout(() => {
      void (async () => {
        // Coalesce changing prefixes/retries behind the one owned request. The
        // server keeps its active slot until native helpers actually close.
        const previous = inFlight.current;
        if (previous) await previous.catch(() => undefined);
        if (!active || activeScope.current !== scope) return;
        let request:
          | ReturnType<DesktopFileMentionsClient["listWorkspaceFileMentions"]>
          | undefined;
        try {
          request = scope.client.listWorkspaceFileMentions({
            workspaceId: scope.workspaceId!,
            path: scope.directory,
          });
          inFlight.current = request;
          const result = await request;
          if (!active || activeScope.current !== scope) return;
          if (result.path !== scope.directory)
            throw new Error("Filename query scope changed");
          setRead({
            scope,
            files: result.files,
            error: null,
            notice: result.truncated
              ? "File suggestions reached a limit. Type a folder path after @ to narrow the search, or retry."
              : null,
          });
        } catch {
          if (active && activeScope.current === scope) {
            setRead({
              scope,
              files: [],
              error: "Workspace file suggestions could not be loaded.",
            });
          }
        } finally {
          if (request && inFlight.current === request) inFlight.current = null;
        }
      })();
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [scope]);

  const current = read?.scope === scope ? read : null;
  const enabled =
    scope.available &&
    scope.workspaceId !== null &&
    scope.readiness === "ready";
  const repoTree = useMemo(
    () =>
      current?.files.map((path) => ({
        path,
        type: "blob" as const,
      })) ?? [],
    [current],
  );
  return {
    repoTree,
    isLoadingRepoTree: enabled && current === null,
    repoTreeError: !availability.available
      ? availability.reason
      : !scope.workspaceId || scope.readiness !== "ready"
        ? "Restore workspace access to add file mentions."
        : (current?.error ?? null),
    repoTreeNotice: current?.notice ?? null,
    retryRepoTree: () => setRetry((value) => value + 1),
  };
}
