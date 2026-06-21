import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchSelector } from "./BranchSelector";

const branches = [
  { name: "main", protected: true },
  { name: "feat/summary", protected: false },
];

describe("BranchSelector", () => {
  it("opens below its trigger and switches branches", () => {
    const onBranchSelect = vi.fn();
    render(
      <BranchSelector
        currentBranch="main"
        branches={branches}
        onBranchSelect={onBranchSelect}
        placement="below"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select branch" }));
    expect(screen.getByRole("dialog", { name: "Switch branch" })).toHaveClass(
      "top-full",
      "w-80",
    );
    fireEvent.click(screen.getByRole("button", { name: "feat/summary" }));
    expect(onBranchSelect).toHaveBeenCalledWith("feat/summary");
  });
});
