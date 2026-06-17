import type { EditArtifactReviewFile, FileStatus } from "@repo/shared-types";

export function mapArtifactFilesToStatus(
  files: EditArtifactReviewFile[],
): FileStatus[] {
  return files.map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    isStaged: file.isStaged ?? false,
  }));
}

export function collectStagedFilePaths(files: FileStatus[]): Set<string> {
  return new Set(
    files.filter((file) => file.isStaged).map((file) => file.path),
  );
}

export function generateCommitMessage(files: FileStatus[]): string {
  const scope = "review";

  if (files.length === 0) {
    return `chore(${scope}): update workspace`;
  }

  if (files.length === 1) {
    return `chore(${scope}): update ${files[0]?.path ?? "workspace"}`;
  }

  return `chore(${scope}): update ${files.length} files`;
}
