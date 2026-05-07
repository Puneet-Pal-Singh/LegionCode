import type { DiffContent, DiffLine } from "@repo/shared-types";

export const REVIEW_COMMENT_PROMPT_HEADING =
  "Please address the following review comments:";
export const REVIEW_COMMENT_MAX_SELECTED = 20;
export const REVIEW_COMMENT_MAX_PROMPT_CHARS = 12_000;

export type ReviewCommentSide = "left" | "right" | "both" | "unknown";
export type ReviewCommentSelectionMode = "single" | "range";
export type ReviewCommentDeliveryState =
  | "draft"
  | "dispatching"
  | "dispatched"
  | "dispatch_failed";

export interface ReviewCommentAnchor {
  hunkIndex: number;
  lineIndex: number;
  rowKey: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  side: ReviewCommentSide;
  linePreview?: string;
}

export interface ReviewCommentDraft {
  id: string;
  filePath: string;
  line: number;
  side: ReviewCommentSide;
  note: string;
  createdAt: string;
  linePreview?: string;
  selected: boolean;
  anchors: ReviewCommentAnchor[];
  primaryAnchor: ReviewCommentAnchor;
  selectionMode: ReviewCommentSelectionMode;
  runId: string;
  sessionId: string;
  diffFingerprint: string;
  stale: boolean;
  deliveryState: ReviewCommentDeliveryState;
}

export interface CreateReviewCommentInput {
  filePath: string;
  line: number;
  side: ReviewCommentSide;
  note: string;
  linePreview?: string;
  anchors: ReviewCommentAnchor[];
  primaryAnchor: ReviewCommentAnchor;
  selectionMode: ReviewCommentSelectionMode;
  diffFingerprint: string;
}

export interface ReviewPromptBuildResult {
  prompt: string;
  count: number;
  charCount: number;
}

export interface ReviewPromptBudgetResult {
  ok: boolean;
  reason: string | null;
}

export function buildDiffFingerprint(diff: DiffContent): string {
  const lineFingerprint = diff.hunks
    .map((hunk, hunkIndex) =>
      hunk.lines
        .map((line, lineIndex) =>
          [
            hunkIndex,
            lineIndex,
            line.type,
            line.oldLineNumber ?? "",
            line.newLineNumber ?? "",
            normalizeLinePreview(line.content),
          ].join(":"),
        )
        .join("|"),
    )
    .join("||");

  return [
    diff.newPath || diff.oldPath,
    diff.isNewFile ? "new" : "existing",
    diff.isDeleted ? "deleted" : "present",
    lineFingerprint,
  ].join("::");
}

export function normalizeLinePreview(content: string): string {
  return content.replace(/^[+\-\s]/, "").trim();
}

export function buildReviewCommentPrompt(
  comments: ReviewCommentDraft[],
  extraInstructions: string,
): ReviewPromptBuildResult {
  const orderedComments = [...comments].sort(compareReviewComments);
  const lines = [REVIEW_COMMENT_PROMPT_HEADING, ""];

  orderedComments.forEach((comment, index) => {
    lines.push(`# Request ${index + 1}`);
    lines.push(`File: ${comment.filePath}`);
    lines.push(`Line: ${comment.line}`);
    if (comment.linePreview) {
      lines.push(`Line preview: ${comment.linePreview}`);
    }
    lines.push(`Comment: ${comment.note}`);
    lines.push("");
  });

  const trimmedInstructions = extraInstructions.trim();
  if (trimmedInstructions) {
    lines.push("Additional instructions:");
    lines.push(trimmedInstructions);
  }

  const prompt = lines.join("\n").trim();
  return {
    prompt,
    count: orderedComments.length,
    charCount: prompt.length,
  };
}

export function validateReviewPromptBudget(
  comments: ReviewCommentDraft[],
  extraInstructions: string,
): ReviewPromptBudgetResult {
  if (comments.length > REVIEW_COMMENT_MAX_SELECTED) {
    return {
      ok: false,
      reason: `Select ${REVIEW_COMMENT_MAX_SELECTED} comments or fewer before sending.`,
    };
  }

  const { charCount } = buildReviewCommentPrompt(comments, extraInstructions);
  if (charCount > REVIEW_COMMENT_MAX_PROMPT_CHARS) {
    return {
      ok: false,
      reason: `Review request is too large to send safely. Remove some comments or shorten the extra instructions.`,
    };
  }

  return { ok: true, reason: null };
}

export function getReviewCommentDisplayLabel(comment: ReviewCommentDraft): string {
  const segments = comment.filePath.split("/");
  const fileName = segments[segments.length - 1] ?? comment.filePath;
  return `${fileName}:${comment.line}`;
}

export function compareReviewComments(
  left: ReviewCommentDraft,
  right: ReviewCommentDraft,
): number {
  if (left.filePath !== right.filePath) {
    return left.filePath.localeCompare(right.filePath);
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

export function rebindReviewCommentDraft(
  draft: ReviewCommentDraft,
  diff: DiffContent,
  diffFingerprint: string,
): ReviewCommentDraft {
  const reboundAnchors = draft.anchors
    .map((anchor) => findMatchingAnchor(anchor, diff))
    .filter((anchor): anchor is ReviewCommentAnchor => anchor !== null);

  if (reboundAnchors.length === 0) {
    return {
      ...draft,
      stale: true,
    };
  }

  const primaryAnchor =
    reboundAnchors.find((anchor) => anchor.side === draft.primaryAnchor.side) ??
    reboundAnchors[reboundAnchors.length - 1];

  if (!primaryAnchor) {
    return {
      ...draft,
      stale: true,
    };
  }

  return {
    ...draft,
    anchors: reboundAnchors,
    primaryAnchor,
    line:
      primaryAnchor.newLineNumber ??
      primaryAnchor.oldLineNumber ??
      draft.line,
    side: primaryAnchor.side,
    linePreview: primaryAnchor.linePreview ?? draft.linePreview,
    diffFingerprint,
    stale: false,
  };
}

function findMatchingAnchor(
  anchor: ReviewCommentAnchor,
  diff: DiffContent,
): ReviewCommentAnchor | null {
  const preview = normalizeLinePreview(anchor.linePreview ?? "");
  for (const [hunkIndex, hunk] of diff.hunks.entries()) {
    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (!lineMatchesAnchor(line, anchor, preview)) {
        continue;
      }
      return {
        hunkIndex,
        lineIndex,
        rowKey: `${hunkIndex}:${lineIndex}`,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        side: deriveAnchorSide(line),
        linePreview: normalizeLinePreview(line.content),
      };
    }
  }

  return null;
}

function lineMatchesAnchor(
  line: DiffLine,
  anchor: ReviewCommentAnchor,
  preview: string,
): boolean {
  const lineSide = deriveAnchorSide(line);
  const sideMatches =
    anchor.side === "unknown" ||
    anchor.side === "both" ||
    anchor.side === lineSide ||
    lineSide === "both";
  if (!sideMatches) {
    return false;
  }

  const oldMatches =
    anchor.oldLineNumber === undefined ||
    anchor.oldLineNumber === line.oldLineNumber;
  const newMatches =
    anchor.newLineNumber === undefined ||
    anchor.newLineNumber === line.newLineNumber;
  if (!oldMatches || !newMatches) {
    return false;
  }

  if (!preview) {
    return true;
  }

  return normalizeLinePreview(line.content) === preview;
}

function deriveAnchorSide(line: DiffLine): ReviewCommentSide {
  if (line.type === "deleted") {
    return "left";
  }
  if (line.type === "added") {
    return "right";
  }
  return "both";
}
