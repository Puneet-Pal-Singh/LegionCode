import { GitServiceError } from "./errors.js";

export function validateWorkspaceRoot(workspaceRoot: string): string {
  const normalized = workspaceRoot.trim();
  if (normalized !== workspaceRoot || normalized.length === 0) {
    throw new GitServiceError(
      "invalid_git_input",
      "Workspace root must be a non-empty absolute path",
      { workspaceRoot },
    );
  }
  if (!workspaceRoot.startsWith("/")) {
    throw new GitServiceError(
      "invalid_git_input",
      "Workspace root must be absolute",
      { workspaceRoot },
    );
  }
  return workspaceRoot;
}
