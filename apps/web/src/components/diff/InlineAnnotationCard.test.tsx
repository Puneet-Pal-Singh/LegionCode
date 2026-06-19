import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewCommentDraft } from "../git/reviewComments";
import { InlineAnnotationCard } from "./InlineAnnotationCard";

const annotation: ReviewCommentDraft = {
  id: "comment-1",
  filePath: "src/example.ts",
  line: 1,
  side: "right",
  note: "Remove this comment",
  createdAt: "2026-06-19T00:00:00.000Z",
  selected: true,
  anchors: [],
  primaryAnchor: {
    rowKey: "row-1",
    hunkIndex: 0,
    lineIndex: 0,
    side: "right",
    newLineNumber: 1,
    linePreview: "const example = true;",
  },
  selectionMode: "single",
  runId: "run-1",
  sessionId: "session-1",
  diffFingerprint: "fingerprint-1",
  stale: false,
  deliveryState: "draft",
};

describe("InlineAnnotationCard", () => {
  it("offers a delete action beside resolve", () => {
    const onResolve = vi.fn();
    const onDelete = vi.fn();
    render(
      <InlineAnnotationCard
        annotation={annotation}
        onReply={vi.fn()}
        onResolve={onResolve}
        onDelete={onDelete}
      />,
    );

    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveClass("ml-auto");
    expect(resolveButton.compareDocumentPosition(deleteButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
  });
});
