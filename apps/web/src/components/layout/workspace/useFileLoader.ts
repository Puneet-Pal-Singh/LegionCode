import { useCallback, useLayoutEffect, useRef } from "react";
import { useGitHub } from "../../github/GitHubContextProvider";
import { useAuth } from "../../../contexts/AuthContext";
import { getFileContent } from "../../../services/GitHubService";
import { readCheckoutFile } from "../../../services/api/checkoutReads";
import type { SelectedFile } from "./useWorkspaceState";
import { parseReadFileOutput } from "@legioncode/sdk";
import { readFileViewPreference, rememberFileView } from "./fileViewPreference";

interface UseFileLoaderProps {
  sessionId: string;
  runId: string;
  setIsLoadingContent: (loading: boolean) => void;
  setContentError: (error: string | null) => void;
  openFileTab: (file: SelectedFile) => void;
}

export function useFileLoader({ sessionId, runId, setIsLoadingContent, setContentError, openFileTab }: UseFileLoaderProps) {
  const { repo, branch } = useGitHub();
  const { user, isAuthenticated } = useAuth();
  const scope = JSON.stringify([isAuthenticated ? user?.id : null, user?.workspaceId, sessionId, runId, repo?.full_name, branch]);
  const currentScope = useRef(scope);
  const requestRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    currentScope.current = scope;
    requestRef.current?.abort();
    requestRef.current = null;
    setIsLoadingContent(false);
    setContentError(null);
    return () => { requestRef.current?.abort(); requestRef.current = null; };
  }, [scope, setContentError, setIsLoadingContent]);

  const load = useCallback(async (path: string, source: "checkout" | "repository", onOpen = openFileTab) => {
    if (!isAuthenticated || !user) return;
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    const isCurrent = () => !request.signal.aborted && currentScope.current === scope && requestRef.current === request;
    setIsLoadingContent(true);
    setContentError(null);
    try {
      let file: SelectedFile;
      if (source === "checkout") {
        const result = await readCheckoutFile(sessionId, runId, path, request.signal);
        const parsed = parseReadFileOutput(result.output);
        file = {
          path,
          content: result.isBinary
            ? "// [LegionCode] This file is a binary and cannot be displayed in the text editor."
            : parsed?.content ?? result.output,
          startingLineNumber: parsed ? parsed.offset + 1 : 1,
        };
      } else {
        if (!repo) throw new Error("Select a repository before opening a file.");
        const result = await getFileContent(repo.owner.login, repo.name, path, branch, request.signal);
        if (Array.isArray(result) || typeof result.content !== "string") throw new Error("The selected GitHub path is not a file.");
        const content = result.encoding === "base64"
          ? new TextDecoder().decode(Uint8Array.from(atob(result.content.replace(/\s/g, "")), (character) => character.charCodeAt(0)))
          : result.content;
        file = { path, content };
      }
      if (!isCurrent()) return;
      rememberFileView(scope, { source, path });
      onOpen(file);
    } catch (error) {
      if (isCurrent()) setContentError(error instanceof Error ? error.message : "The file could not be opened.");
    } finally {
      if (isCurrent()) setIsLoadingContent(false);
    }
  }, [branch, isAuthenticated, openFileTab, repo, runId, scope, sessionId, setContentError, setIsLoadingContent, user]);

  const handleFileClick = useCallback((path: string, onOpen?: (file: SelectedFile) => void) => load(path, "checkout", onOpen), [load]);
  const handleGitHubFileSelect = useCallback((path: string, onOpen?: (file: SelectedFile) => void) => load(path, "repository", onOpen), [load]);
  const restoreLastViewedFile = useCallback(() => {
    const selection = readFileViewPreference(scope);
    if (selection) void load(selection.path, selection.source);
  }, [load, scope]);
  const rememberSavedPreview = useCallback(() => rememberFileView(scope, null), [scope]);
  return { handleFileClick, handleGitHubFileSelect, restoreLastViewedFile, rememberSavedPreview };
}
