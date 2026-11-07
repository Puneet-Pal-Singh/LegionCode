import { forwardRef, useCallback } from "react";
import { SharedFileExplorer, type FileExplorerHandle, type FileExplorerReadPort } from "@legioncode/client-ui";
import { type CheckoutTurnIdentity, listCheckoutFiles } from "../services/api/checkoutReads";
import { useAuth } from "../contexts/AuthContext";

export type { FileExplorerHandle } from "@legioncode/client-ui";
interface FileExplorerProps {
  sessionId: string;
  runId: string;
  checkoutTurn?: CheckoutTurnIdentity;
  onFileClick?: (path: string) => void;
  filterQuery?: string;
}

export const FileExplorer = forwardRef<FileExplorerHandle, FileExplorerProps>(
  ({ sessionId, runId, checkoutTurn, onFileClick, filterQuery }, ref) => {
    const { user, isAuthenticated } = useAuth();
    const turnId = checkoutTurn?.turnId;
    const runAttemptId = checkoutTurn?.runAttemptId;
    const listFiles: FileExplorerReadPort = useCallback(async (path, cursor, signal) => {
      if (!turnId || !runAttemptId) throw new Error("Start a task before browsing its checkout.");
      if (cursor !== null && typeof cursor !== "number") throw new Error("Invalid checkout pagination offset");
      const result = await listCheckoutFiles({ sessionId, runId, turnId, runAttemptId, path, offset: cursor ?? 0 }, signal);
      return {
        entries: result.entries.map((entry) => ({ ...entry, path: path === "." ? entry.name : `${path}/${entry.name}` })),
        nextCursor: result.nextOffset,
      };
    }, [sessionId, runId, turnId, runAttemptId, user?.id, user?.workspaceId, isAuthenticated]);
    return <SharedFileExplorer
      ref={ref}
      scopeKey={JSON.stringify([sessionId, runId, turnId, runAttemptId, user?.id, user?.workspaceId, isAuthenticated])}
      enabled={!!user && isAuthenticated}
      listFiles={listFiles}
      onFileClick={onFileClick}
      filterQuery={filterQuery}
    />;
  },
);
FileExplorer.displayName = "FileExplorer";
