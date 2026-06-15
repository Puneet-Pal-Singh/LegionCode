import { GitServiceError } from "./errors.js";

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

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

export function validateRepoRelativePath(path: string): string {
  const normalized = path.trim();
  if (normalized !== path || normalized.length === 0) {
    throw new GitServiceError(
      "invalid_git_input",
      "Git path must be a non-empty repo-relative path",
      { path },
    );
  }
  if (
    path.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(path) ||
    path.includes("\\")
  ) {
    throw new GitServiceError(
      "invalid_git_input",
      "Git path must be relative to the repository",
      { path },
    );
  }
  if (path.split("/").some(isUnsafePathSegment)) {
    throw new GitServiceError(
      "invalid_git_input",
      "Git path cannot escape the repository",
      { path },
    );
  }
  return path;
}

export function validateExplicitRepoPaths(
  paths: readonly string[],
): readonly string[] {
  if (paths.length === 0) {
    throw new GitServiceError(
      "invalid_git_input",
      "At least one explicit repo-relative path is required",
    );
  }
  return paths.map((path) => validateRepoRelativePath(path));
}

function isUnsafePathSegment(segment: string): boolean {
  return segment.length === 0 || segment === "." || segment === "..";
}
