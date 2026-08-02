import type {
  DiffContent,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import type { LifecycleTerminalViewModel } from "../../../services/lifecycle/LifecycleTerminalTypes.js";
import { buildDiffContentFromTurnDiff } from "../../../services/lifecycle/TurnDiffPatchParser.js";
import type { TurnDiffPayload } from "../../../services/api/lifecycleClient.js";

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

export function buildArtifactChangedFileDiffCacheKey(
  artifactId: string,
  file: FileStatus,
): string {
  return `artifact:${artifactId}:${file.path}`;
}

export function resolveTerminalChangedFilesSummary(input: {
  terminalViewModel: LifecycleTerminalViewModel;
  files: FileStatus[];
  turnDiff: TurnDiffPayload | null;
  loadArtifactFileDiff: (
    artifactId: string,
    file: FileStatus,
  ) => Promise<DiffContent>;
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
    loadFileDiff: (file) => loadTurnDiffFile(input, file),
    onReviewOpen: input.onReviewOpen,
  };
}

async function loadTurnDiffFile(
  input: Parameters<typeof resolveTerminalChangedFilesSummary>[0],
  file: FileStatus,
): Promise<DiffContent> {
  if (!input.turnDiff) {
    throw new Error(`Canonical turn diff is required to render ${file.path}`);
  }
  const diff = buildDiffContentFromTurnDiff(input.turnDiff, file.path);
  if (!diff) {
    throw new Error(`Canonical turn diff is missing ${file.path}`);
  }
  return diff;
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
