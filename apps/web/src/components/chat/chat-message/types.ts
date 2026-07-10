import type { DiffContent, DiffLine, FileStatus } from "@repo/shared-types";

export interface ChangedFilesSummary {
  files: FileStatus[];
  loadFileDiff?: (file: FileStatus) => Promise<DiffContent>;
  onReviewOpen?: () => void;
}

export interface ChangedFileDiffState {
  loading: boolean;
  diff?: DiffContent;
  error?: string;
}

export interface ChangeLineStats {
  additions: number | null;
  deletions: number | null;
}

export type InlineDiffRow =
  | { kind: "line"; key: string; line: DiffLine }
  | { kind: "separator"; key: string };
