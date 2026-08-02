import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopEnvironmentSummary } from "./TopEnvironmentSummary";

const mockEnvironmentSummary = vi.hoisted(() => vi.fn());

vi.mock("../layout/workspace/EnvironmentSummaryMenu", () => ({
  EnvironmentSummaryMenu: (props: unknown) => {
    mockEnvironmentSummary(props);
    return (
    <button type="button">Toggle environment summary</button>
    );
  },
}));

describe("TopEnvironmentSummary", () => {
  it("renders persisted repository metadata without attaching a Git observer", () => {
    render(
      <TopEnvironmentSummary
        repo={null}
        branch="main"
        onBranchChange={vi.fn()}
        onOpenChanges={vi.fn()}
        onOpenCommit={vi.fn()}
      />,
    );

    expect(mockEnvironmentSummary).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "main", changedFileCount: 0 }),
    );
  });
});
