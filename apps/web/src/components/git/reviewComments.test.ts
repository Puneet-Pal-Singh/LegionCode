import { describe, expect, it } from "vitest";
import {
  buildReviewCommentPrompt,
  validateReviewPromptBudget,
  type ReviewCommentDraft,
} from "./reviewComments";

function createDraft(
  overrides: Partial<ReviewCommentDraft> = {},
): ReviewCommentDraft {
  return {
    id: overrides.id ?? "comment-1",
    filePath: overrides.filePath ?? "apps/web/src/App.tsx",
    line: overrides.line ?? 10,
    side: overrides.side ?? "right",
    note: overrides.note ?? "Check this branch.",
    createdAt: overrides.createdAt ?? "2026-05-05T00:00:00.000Z",
    linePreview: overrides.linePreview ?? "const value = nextValue;",
    selected: overrides.selected ?? true,
    anchors: overrides.anchors ?? [
      {
        hunkIndex: 0,
        lineIndex: 0,
        rowKey: "0:0",
        newLineNumber: overrides.line ?? 10,
        side: "right",
        linePreview: overrides.linePreview ?? "const value = nextValue;",
      },
    ],
    primaryAnchor:
      overrides.primaryAnchor ??
      ({
        hunkIndex: 0,
        lineIndex: 0,
        rowKey: "0:0",
        newLineNumber: overrides.line ?? 10,
        side: "right",
        linePreview: overrides.linePreview ?? "const value = nextValue;",
      } as ReviewCommentDraft["primaryAnchor"]),
    selectionMode: overrides.selectionMode ?? "single",
    runId: overrides.runId ?? "run-1",
    sessionId: overrides.sessionId ?? "session-1",
    diffFingerprint: overrides.diffFingerprint ?? "fingerprint-1",
    stale: overrides.stale ?? false,
    deliveryState: overrides.deliveryState ?? "draft",
  };
}

describe("reviewComments", () => {
  it("builds a deterministic prompt ordered by file and line", () => {
    const result = buildReviewCommentPrompt(
      [
        createDraft({
          id: "comment-b",
          filePath: "apps/web/src/z.ts",
          line: 18,
          note: "Use the helper.",
        }),
        createDraft({
          id: "comment-a",
          filePath: "apps/web/src/a.ts",
          line: 4,
          note: "Extract this branch.",
        }),
      ],
      "Keep the existing visuals.",
    );

    expect(result.prompt).toContain(
      "# Request 1\nFile: apps/web/src/a.ts\nLine: 4",
    );
    expect(result.prompt).toContain(
      "# Request 2\nFile: apps/web/src/z.ts\nLine: 18",
    );
    expect(result.prompt).toContain("Additional instructions:");
    expect(result.prompt).toContain("Keep the existing visuals.");
  });

  it("blocks oversize review dispatches instead of truncating", () => {
    const comments = Array.from({ length: 21 }, (_, index) =>
      createDraft({
        id: `comment-${index}`,
        line: index + 1,
      }),
    );

    expect(validateReviewPromptBudget(comments, "")).toEqual({
      ok: false,
      reason: "Select 20 comments or fewer before sending.",
    });
  });
});
