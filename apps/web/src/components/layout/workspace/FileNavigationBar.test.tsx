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
        filesOpen={false}
      />,
    );

    expect(screen.getByText("apps")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("button", { name: "Cursor" })).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Toggle files" })
        .querySelector(".lucide-folders"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle files" }));
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
        filesOpen={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "File options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/App.tsx"));

    fireEvent.click(screen.getByRole("button", { name: "File options" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Disable word wrap" }),
    );
    expect(onWordWrapChange).toHaveBeenCalledWith(false);
  });

  it("copies content and disables the default markdown rich preview", async () => {
    const onRichPreviewChange = vi.fn();
    render(
      <FileNavigationBar
        path="README.md"
        content="# Hello"
        filesOpen
        wordWrap
        richPreview
        onWordWrapChange={vi.fn()}
        onRichPreviewChange={onRichPreviewChange}
        onOpenFiles={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "File options" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy file contents" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Hello"));

    fireEvent.click(screen.getByRole("button", { name: "File options" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Disable rich preview" }),
    );
    expect(onRichPreviewChange).toHaveBeenCalledWith(false);
  });
});
