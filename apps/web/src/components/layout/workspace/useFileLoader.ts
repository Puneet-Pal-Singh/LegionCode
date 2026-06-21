import { useCallback } from "react";
import { z } from "zod";
import { useGitHub } from "../../github/GitHubContextProvider";
import { getFileContent } from "../../../services/GitHubService";
import { terminalCommandPath } from "../../../lib/platform-endpoints";
import type { SelectedFile } from "./useWorkspaceState";

interface UseFileLoaderProps {
  sandboxId: string;
  runId: string;
  setIsLoadingContent: (loading: boolean) => void;
  setContentError: (error: string | null) => void;
  openFileTab: (file: SelectedFile) => void;
}

export function useFileLoader({
  sandboxId,
  runId,
  setIsLoadingContent,
  setContentError,
  openFileTab,
}: UseFileLoaderProps) {
  const { repo, branch } = useGitHub();

  const handleFileClick = useCallback(
    async (path: string) => {
      setIsLoadingContent(true);
      setContentError(null);
      localStorage.setItem("shadowbox_last_viewed_path", path);
      try {
        const res = await fetch(terminalCommandPath(sandboxId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plugin: "filesystem",
            payload: { action: "read_file", runId, path },
          }),
        });

        let data: unknown;
        try {
          data = await res.json();
        } catch (parseError) {
          console.error("Failed to parse file response:", parseError);
          setContentError("The file response could not be read.");
          return;
        }

        const parsedData = FileReadSuccessSchema.safeParse(data);
        if (parsedData.success) {
          if (
            parsedData.data.isBinary ||
            parsedData.data.output === "[BINARY_FILE_DETECTED]"
          ) {
            openFileTab({
              path,
              content:
                "// [LegionCode] This file is a binary and cannot be displayed in the text editor.",
            });
          } else {
            openFileTab({ path, content: parsedData.data.output });
          }
        } else {
          setContentError("The file could not be opened.");
        }
      } catch (e) {
        console.error("Failed to read file:", e);
        setContentError("Failed to connect to the workspace file service.");
      } finally {
        setIsLoadingContent(false);
      }
    },
    [openFileTab, runId, sandboxId, setContentError, setIsLoadingContent],
  );

  const handleGitHubFileSelect = useCallback(
    async (path: string) => {
      if (!repo) return;

      setIsLoadingContent(true);
      setContentError(null);
      localStorage.setItem("shadowbox_last_viewed_path", path);

      try {
        const fileData = await getFileContent(
          repo.owner.login,
          repo.name,
          path,
          branch,
        );

        // GitHub API returns base64 encoded content
        if (fileData.encoding === "base64") {
          const decoded = atob(fileData.content);
          openFileTab({ path, content: decoded });
        } else {
          openFileTab({ path, content: fileData.content });
        }
      } catch (error) {
        console.error("Failed to fetch GitHub file content:", error);
        setContentError("Failed to fetch the file content from GitHub.");
      } finally {
        setIsLoadingContent(false);
      }
    },
    [branch, openFileTab, repo, setContentError, setIsLoadingContent],
  );

  return {
    handleFileClick,
    handleGitHubFileSelect,
  };
}

const FileReadSuccessSchema = z.object({
  success: z.literal(true),
  output: z.string(),
  isBinary: z.boolean().optional(),
});
