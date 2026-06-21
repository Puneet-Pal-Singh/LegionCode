import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactView } from "./ArtifactView";

describe("ArtifactView", () => {
  it("renders markdown as rich content when preview is enabled", () => {
    render(
      <ArtifactView
        isOpen
        title="README.md"
        content="# Preview heading"
        richPreview
      />,
    );

    expect(screen.getByRole("heading", { name: "Preview heading" })).toBeInTheDocument();
  });
});
