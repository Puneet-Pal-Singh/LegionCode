import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileNavigationBar } from "./FileNavigationBar";

const writeText = vi.fn().mockResolvedValue(undefined);

describe("FileNavigationBar", () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("shows breadcrumbs and opens the file tree", () => {
    const onOpenFiles = vi.fn();
    render(
      <FileNavigationBar
        path="apps/web/src/App.tsx"
        wordWrap
        onWordWrapChange={vi.fn()}
        onOpenFiles={onOpenFiles}
      />,
    );

    expect(screen.getByText("apps")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  it("copies the path and toggles word wrap from file options", async () => {
    const onWordWrapChange = vi.fn();
    render(
      <FileNavigationBar
        path="src/App.tsx"
        wordWrap
        onWordWrapChange={onWordWrapChange}
        onOpenFiles={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "File options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/App.tsx"));

    fireEvent.click(screen.getByRole("button", { name: "File options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable word wrap" }));
    expect(onWordWrapChange).toHaveBeenCalledWith(false);
  });
});
