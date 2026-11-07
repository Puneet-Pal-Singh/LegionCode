import type { LocalWorkspaceGrant, WorkspaceId } from "@repo/platform-protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DesktopWorkspaceFiles,
  type DesktopWorkspaceFilesProps,
} from "./DesktopWorkspaceFiles";

interface Props {
  client: DesktopWorkspaceFilesProps["client"];
  workspaceId: WorkspaceId;
  grantedAt: LocalWorkspaceGrant["grantedAt"];
  readiness: LocalWorkspaceGrant["readiness"];
  availability: DesktopWorkspaceFilesProps["availability"];
}

type ReadScope = Pick<
  Props,
  "client" | "workspaceId" | "grantedAt" | "readiness"
>;

/** Runtime availability comes from the handshake, never from method presence. */
export function DesktopWorkspaceFilesMount({
  client,
  workspaceId,
  grantedAt,
  readiness,
  availability,
}: Props) {
  const [scope, setScope] = useState<ReadScope>({
    client,
    workspaceId,
    grantedAt,
    readiness,
  });
  const activeScope = useRef<ReadScope | null>(scope);
  const [refresh, setRefresh] = useState(0);
  const scopeMatches =
    scope.client === client &&
    scope.workspaceId === workspaceId &&
    scope.grantedAt === grantedAt &&
    scope.readiness === readiness;
  useLayoutEffect(() => {
    const next = scopeMatches
      ? scope
      : { client, workspaceId, grantedAt, readiness };
    activeScope.current = next;
    if (!scopeMatches) {
      setScope(next);
      setRefresh(0);
    }
    return () => {
      if (activeScope.current === next) activeScope.current = null;
    };
  }, [client, workspaceId, grantedAt, readiness, scope, scopeMatches]);

  const scopedClient = useMemo<Props["client"]>(() => {
    const captured = scope;
    const assertCurrent = (requestWorkspaceId: WorkspaceId): void => {
      if (
        activeScope.current !== captured ||
        captured.readiness !== "ready" ||
        requestWorkspaceId !== captured.workspaceId
      ) {
        throw new DOMException("Workspace files scope changed.", "AbortError");
      }
    };
    return {
      listWorkspaceFiles: async (params) => {
        assertCurrent(params.workspaceId);
        const result = await captured.client.listWorkspaceFiles(params);
        assertCurrent(params.workspaceId);
        return result;
      },
      readWorkspaceFile: async (params) => {
        assertCurrent(params.workspaceId);
        const result = await captured.client.readWorkspaceFile(params);
        assertCurrent(params.workspaceId);
        return result;
      },
    };
  }, [scope]);

  // Remove prior-grant content before its replacement may issue a fresh read.
  if (!scopeMatches) return <p role="status">Opening workspace files…</p>;
  if (readiness !== "ready")
    return <p role="status">Restore workspace access to browse files.</p>;
  return (
    <div className="space-y-3">
      {availability.available ? (
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh files
          </button>
        </div>
      ) : null}
      <DesktopWorkspaceFiles
        key={`${scope.workspaceId}:${scope.grantedAt}:${scope.readiness}:${refresh}`}
        client={scopedClient}
        workspaceId={workspaceId}
        availability={availability}
      />
    </div>
  );
}
