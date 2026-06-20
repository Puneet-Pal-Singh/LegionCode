import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangesList } from "./ChangesList";

const files = [
  {
    path: "src/alpha.ts",
    status: "modified" as const,
    isStaged: false,
    additions: 2,
    deletions: 1,
  },
  {
    path: "tests/beta.test.ts",
    status: "added" as const,
    isStaged: false,
    additions: 4,
    deletions: 0,
  },
];

describe("ChangesList", () => {
  it("filters changed files by path", () => {
    render(
      <ChangesList
        files={files}
        selectedFile={null}
        onSelectFile={vi.fn()}
        reviewScope="git-changes"
        onReviewScopeChange={vi.fn()}
        showToolbar={false}
        searchable
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Filter files..."), {
      target: { value: "beta" },
    });

    expect(screen.getByText("beta.test.ts")).toBeInTheDocument();
    expect(screen.queryByText("alpha.ts")).not.toBeInTheDocument();
  });
});
