import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopEnvironmentSummary } from "./TopEnvironmentSummary";

const mockUseGitStatus = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: (
    runId?: string,
    sessionId?: string,
    enabled?: boolean,
  ) => {
    mockUseGitStatus(runId, sessionId, enabled);
    return {
      status: null,
    };
  },
}));

vi.mock("../layout/workspace/EnvironmentSummaryMenu", () => ({
  EnvironmentSummaryMenu: () => (
    <button type="button">Toggle environment summary</button>
  ),
}));

describe("TopEnvironmentSummary", () => {
  beforeEach(() => {
    mockUseGitStatus.mockClear();
  });

  it("does not probe git status while environment summary is disabled", () => {
    render(
      <TopEnvironmentSummary
        sessionId="session-1"
        runId="run-1"
        repo={null}
        branch="main"
        enabled={false}
        onBranchChange={vi.fn()}
        onOpenChanges={vi.fn()}
        onOpenCommit={vi.fn()}
      />,
    );

    expect(mockUseGitStatus).toHaveBeenCalledWith("run-1", "session-1", false);
  });
});
