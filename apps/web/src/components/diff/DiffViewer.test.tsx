import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiffContent, DiffLine } from "@repo/shared-types";
import { DiffViewer } from "./DiffViewer";

function unchangedLine(lineNumber: number): DiffLine {
  return {
    type: "unchanged",
    content: `const value${lineNumber} = ${lineNumber};`,
    oldLineNumber: lineNumber,
    newLineNumber: lineNumber,
  };
}

describe("DiffViewer", () => {
  it("collapses unchanged regions around changed lines", () => {
    const diff: DiffContent = {
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      isBinary: false,
      isNewFile: false,
      isDeleted: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 12,
          newStart: 1,
          newLines: 13,
          header: "@@ -1,12 +1,13 @@",
          lines: [
            unchangedLine(1),
            unchangedLine(2),
            unchangedLine(3),
            unchangedLine(4),
            unchangedLine(5),
            unchangedLine(6),
            {
              type: "added",
              content: "const added = true;",
              newLineNumber: 7,
            },
            unchangedLine(8),
            unchangedLine(9),
            unchangedLine(10),
            unchangedLine(11),
            unchangedLine(12),
          ],
        },
      ],
    };

    render(<DiffViewer diff={diff} />);

    expect(screen.getByText("3 unmodified lines")).toBeInTheDocument();
    expect(screen.getByText("2 unmodified lines")).toBeInTheDocument();
    expect(
      screen.getAllByText((_, node) =>
        Boolean(node?.textContent?.includes("const added = true")),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("defaults to word wrap enabled", () => {
    render(
      <DiffViewer
        diff={{
          oldPath: "src/example.ts",
          newPath: "src/example.ts",
          isBinary: false,
          isNewFile: false,
          isDeleted: false,
          hunks: [],
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText("Diff view options"));

    expect(screen.getByRole("menuitem", { name: "Disable word wrap" })).toBeInTheDocument();
  });
});
