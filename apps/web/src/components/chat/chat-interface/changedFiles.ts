import type {
  DiffContent,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import type { LifecycleTerminalViewModel } from "../../../services/lifecycle/LifecycleTerminalTypes.js";

export function resolveChangedFilesSummary(input: {
  messageId: string;
  snapshots: Record<string, FileStatus[]>;
  artifacts: Record<string, PromptArtifactReviewSource>;
  loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
  onPromptArtifactReview: (artifactId: string) => void;
}):
  | {
      files: FileStatus[];
      loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
      onReviewOpen?: () => void;
    }
  | undefined {
  const artifact = input.artifacts[input.messageId];
  if (artifact?.files.length) {
    return {
      files: artifact.files.map(mapReviewFileToStatus),
      loadFileDiff: input.loadFileDiff,
      onReviewOpen: () => input.onPromptArtifactReview(artifact.artifactId),
    };
  }

  const files = input.snapshots[input.messageId];
  if (!files?.length) {
    return undefined;
  }

  return {
    files,
    loadFileDiff: input.loadFileDiff,
  };
}

function mapReviewFileToStatus(
  file: PromptArtifactReviewSource["files"][number],
): FileStatus {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    isStaged: file.isStaged ?? false,
  };
}

export function mergeChangedFileSnapshots(
  localSnapshots: Record<string, FileStatus[]>,
  activitySnapshots: Record<string, FileStatus[]>,
): Record<string, FileStatus[]> {
  return {
    ...localSnapshots,
    ...activitySnapshots,
  };
}

export function hasChangedFileSnapshot(
  snapshots: Record<string, FileStatus[]>,
): boolean {
  return Object.values(snapshots).some((files) => files.length > 0);
}

export function hasArtifactChangedFileSnapshot(
  artifacts: Record<string, PromptArtifactReviewSource>,
): boolean {
  return Object.values(artifacts).some((artifact) => artifact.files.length > 0);
}

export function buildChangedFileDiffCacheKey(
  messageId: string,
  file: FileStatus,
): string {
  return `${messageId}:${file.path}:${file.isStaged ? "staged" : "unstaged"}`;
}

export function buildArtifactChangedFileDiffCacheKey(
  artifactId: string,
  file: FileStatus,
): string {
  return `artifact:${artifactId}:${file.path}`;
}

export function resolveTerminalChangedFilesSummary(input: {
  terminalViewModel: LifecycleTerminalViewModel;
  files: FileStatus[];
  loadArtifactFileDiff: (
    artifactId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
  loadFallbackFileDiff: (file: FileStatus) => Promise<DiffContent>;
  onPromptArtifactReview: (artifactId: string) => void;
  onReviewOpen?: () => void;
}):
  | {
      files: FileStatus[];
      loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
      onReviewOpen?: () => void;
    }
  | undefined {
  if (input.files.length === 0) {
    return undefined;
  }

  if (input.terminalViewModel.artifactId) {
    const artifactId = input.terminalViewModel.artifactId;
    return {
      files: input.files,
      loadFileDiff: (file) => input.loadArtifactFileDiff(artifactId, file),
      onReviewOpen: () => input.onPromptArtifactReview(artifactId),
    };
  }

  return {
    files: input.files,
    loadFileDiff: input.loadFallbackFileDiff,
    onReviewOpen: input.onReviewOpen,
  };
}

export function buildDiffFromActivityPreview(
  file: FileStatus,
): DiffContent | null {
  const diffPreview = readActivityDiffPreview(file);
  if (!diffPreview) {
    return null;
  }

  const lines = buildDiffLinesFromActivityPreview(diffPreview);
  if (!lines.some((line) => line.type === "added" || line.type === "deleted")) {
    return null;
  }

  return {
    oldPath: file.path,
    newPath: file.path,
    isBinary: false,
    isNewFile: file.status === "added",
    isDeleted: file.status === "deleted",
    hunks: [
      {
        oldStart: 1,
        oldLines: lines.filter((line) => line.type !== "added").length,
        newStart: 1,
        newLines: lines.filter((line) => line.type !== "deleted").length,
        header: "Saved edit preview",
        lines,
      },
    ],
  };
}

function readActivityDiffPreview(file: FileStatus): string | null {
  const candidate = file as FileStatus & { diffPreview?: unknown };
  if (typeof candidate.diffPreview !== "string") {
    return null;
  }
  const trimmed = candidate.diffPreview.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDiffLinesFromActivityPreview(
  diffPreview: string,
): DiffContent["hunks"][number]["lines"] {
  let oldLineNumber = 1;
  let newLineNumber = 1;
  return diffPreview
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => {
      if (line.startsWith("+")) {
        return {
          type: "added" as const,
          content: line,
          newLineNumber: newLineNumber++,
        };
      }
      if (line.startsWith("-")) {
        return {
          type: "deleted" as const,
          content: line,
          oldLineNumber: oldLineNumber++,
        };
      }
      const diffLine = {
        type: "unchanged" as const,
        content: line,
        oldLineNumber,
        newLineNumber,
      };
      oldLineNumber += 1;
      newLineNumber += 1;
      return diffLine;
    });
}

export function collectChangedFilesSinceBaseline(
  files: FileStatus[],
  baselineFiles: FileStatus[],
): FileStatus[] {
  if (baselineFiles.length === 0) {
    return cloneFileStatuses(files);
  }

  const baselineByPath = new Map(
    baselineFiles.map((file) => [file.path, fileStatusSignature(file)]),
  );
  return files
    .filter(
      (file) => baselineByPath.get(file.path) !== fileStatusSignature(file),
    )
    .map((file) => ({ ...file }));
}

function fileStatusSignature(file: FileStatus): string {
  return [
    file.status,
    file.additions,
    file.deletions,
    file.isStaged ? "staged" : "unstaged",
  ].join(":");
}

export function areFileStatusListsEqual(
  left: FileStatus[] | undefined,
  right: FileStatus[],
): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }

  return left.every((file, index) => {
    const rightFile = right[index];
    return (
      rightFile !== undefined &&
      file.path === rightFile.path &&
      fileStatusSignature(file) === fileStatusSignature(rightFile)
    );
  });
}

export function cloneFileStatuses(files: FileStatus[]): FileStatus[] {
  return files.map((file) => ({ ...file }));
}
