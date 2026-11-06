import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  listWorkspaces,
  type WorkspaceSelection,
} from "../services/api/workspaceSelection";

interface SelectionRead {
  account: { userId: string | undefined };
  selection: WorkspaceSelection | null;
  verified: boolean;
  revision: number;
  error: string | null;
}

/** Render the authenticated server selection and explicitly retry unavailable reads. */
export function useOwnedWorkspaceSelection(userId: string | undefined) {
  const [read, setRead] = useState<SelectionRead | null>(null);
  const [revision, setRevision] = useState(0);
  const account = useMemo(() => ({ userId }), [userId]);
  const requestIdRef = useRef(0);
  const revisionRef = useRef(revision);
  const activeAccountRef = useRef<typeof account | null>(null);

  useLayoutEffect(() => {
    activeAccountRef.current = account;
    revisionRef.current = revision;
    requestIdRef.current += 1;
    return () => {
      activeAccountRef.current = null;
      requestIdRef.current += 1;
    };
  }, [account, revision]);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    const isCurrent = () => !controller.signal.aborted &&
      requestId === requestIdRef.current && activeAccountRef.current === account;
    void Promise.resolve().then(() => listWorkspaces(controller.signal))
      .then((response) => {
        if (!isCurrent()) return;
        const selection = response.selection;
        const ownedAndActive = selection !== null && response.workspaces.some(
          ({ selected, workspace }) => selected &&
            workspace.id === selection.workspaceId && workspace.status === "active",
        );
        setRead({
          account,
          selection: ownedAndActive ? selection : null,
          verified: true,
          revision,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        setRead((current) => ({
          account,
          selection: current?.account === account ? current.selection : null,
          verified: current?.account === account && current.verified,
          revision,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => controller.abort();
  }, [account, revision, userId]);

  const recordSelection = useCallback((selection: WorkspaceSelection) => {
    if (!account.userId || activeAccountRef.current !== account) return;
    requestIdRef.current += 1;
    setRead({ account, selection, verified: true, revision: revisionRef.current, error: null });
  }, [account]);
  const retry = useCallback(() => setRevision((current) => current + 1), []);
  const current = userId && read?.account === account ? read : null;

  return {
    selection: current?.selection ?? null,
    isResolved: Boolean(current?.verified),
    isLoading: Boolean(userId && current?.revision !== revision),
    error: current?.revision === revision ? current.error : null,
    recordSelection,
    retry,
  };
}
