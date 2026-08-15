import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EventIdSchema,
  ItemIdSchema,
  TurnDiffPayloadSchema,
  TurnIdSchema,
} from "@repo/platform-client-sdk";
import { createTurnWorkflowProjection } from "@repo/platform-client-sdk";
import { CanonicalWorkflowSurface } from "./CanonicalWorkflowSurface.js";

describe("CanonicalWorkflowSurface", () => {
  it("keeps settled workflow history visible without waiting for refresh", () => {
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
          toolName: "read_file",
          filePath: "README.md",
          command: null,
          outputContent: "# README",
          diffPreview: null,
          additions: null,
          deletions: null,
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
    expect(
      screen.getByTestId("workflow-summary-chevron-right"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /read files/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /worked for 2s/i }));
    expect(
      screen.getByRole("button", { name: /worked for 2s/i }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByTestId("workflow-summary-chevron-down"),
    ).toBeInTheDocument();
    expect(screen.getByText("Read README.md")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /read files/i }),
    ).not.toBeInTheDocument();
    const toolDetails = screen.getByRole("button", {
      name: /view details for read readme/i,
    });
    expect(toolDetails).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("canonical-plan-diff-chip"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /review finalized changes/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps active workflow details visible without a disclosure chevron", () => {
    const projection = {
      ...createTurnWorkflowProjection(TurnIdSchema.parse("trn_active01")),
      phase: "working" as const,
      startedAt: "2026-07-27T10:00:00.000Z",
    };

    render(<CanonicalWorkflowSurface projection={projection} />);

    expect(screen.getByText(/working for/i)).toBeInTheDocument();
    expect(
      screen.queryByTestId("workflow-summary-chevron-right"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("workflow-summary-chevron-down"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });
});
