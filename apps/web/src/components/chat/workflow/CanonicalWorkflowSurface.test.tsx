import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EventIdSchema,
  ItemIdSchema,
  TurnDiffPayloadSchema,
  TurnIdSchema,
} from "@repo/platform-protocol";
import { createTurnWorkflowProjection } from "@repo/platform-client-sdk";
import { CanonicalWorkflowSurface } from "./CanonicalWorkflowSurface.js";

describe("CanonicalWorkflowSurface", () => {
  it("collapses settled work while keeping ordered tool details outside the disclosure", () => {
    const projection = {
      ...createTurnWorkflowProjection(TurnIdSchema.parse("trn_surface01")),
      phase: "completed" as const,
      startedAt: "2026-07-27T10:00:00.000Z",
      settledAt: "2026-07-27T10:00:02.000Z",
      items: [
        {
          itemId: ItemIdSchema.parse("itm_surface01"),
          sequence: 1,
          kind: "tool_call" as const,
          status: "completed" as const,
          text: "",
          detail: "Read README.md",
          toolFamily: "read",
          safeSummary: null,
          inputSummary: "Read README.md",
          outputSummary: null,
          planSteps: [],
          compactionPhase: null,
          startedAt: "2026-07-27T10:00:00.000Z",
          completedAt: "2026-07-27T10:00:01.000Z",
        },
      ],
      terminal: {
        state: "completed" as const,
        eventId: EventIdSchema.parse("evt_surface01"),
        content: "completed",
        occurredAt: "2026-07-27T10:00:02.000Z",
      },
      turnDiff: TurnDiffPayloadSchema.parse({
        turnId: "trn_surface01",
        startSnapshot: {
          turnId: "trn_surface01",
          snapshotKey: "start",
          treeId: "a".repeat(40),
          headSha: "b".repeat(40),
          phase: "start",
          capturedAt: "2026-07-27T10:00:00.000Z",
        },
        terminalSnapshot: {
          turnId: "trn_surface01",
          snapshotKey: "terminal",
          treeId: "c".repeat(40),
          headSha: "d".repeat(40),
          phase: "terminal",
          capturedAt: "2026-07-27T10:00:02.000Z",
        },
        files: [
          {
            path: "README.md",
            status: "modified",
            additions: 1,
            deletions: 0,
            previousPath: null,
          },
        ],
        patch: "diff --git a/README.md b/README.md",
      }),
    };
    render(<CanonicalWorkflowSurface projection={projection} />);

    const surface = screen.getByTestId("canonical-workflow");
    expect(surface).toHaveAttribute("data-terminal-state", "completed");
    expect(
      screen.getByRole("button", { name: /worked for 2s/i }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read README.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /worked for 2s/i }));
    fireEvent.click(screen.getByRole("button", { name: /read files/i }));
    expect(screen.getByText("Read README.md")).toBeInTheDocument();
    expect(screen.getByTestId("canonical-plan-diff-chip")).toHaveTextContent(
      "1 file changed · +1 -0",
    );
    expect(
      screen.queryByRole("button", { name: /review finalized changes/i }),
    ).not.toBeInTheDocument();
  });
});
