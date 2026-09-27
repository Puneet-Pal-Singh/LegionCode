// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFrame } from "./WorkspaceFrame.js";

afterEach(cleanup);

function mockViewport(width: number): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === "(max-width: 1023px)" && width <= 1023,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })) as typeof window.matchMedia;
}

beforeEach(() => mockViewport(800));

function renderWorkspace(sidebarOpen?: boolean) {
  return render(
    <WorkspaceFrame
      sidebar={
        <aside>
          <button type="button">First navigation link</button>
          <button type="button">Last navigation link</button>
        </aside>
      }
      topBar={<span>Workspace</span>}
      sidebarOpen={sidebarOpen}
    >
      <button type="button">Main content action</button>
    </WorkspaceFrame>,
  );
}

describe("WorkspaceFrame responsive navigation", () => {
  it("traps compact drawer focus, inerts the main content, and restores focus after Escape", () => {
    renderWorkspace();

    const menuButton = screen.getByRole("button", { name: "Open sidebar" });
    fireEvent.click(menuButton);

    const dialog = screen.getByRole("dialog", { name: "Workspace navigation" });
    const first = screen.getByRole("button", { name: "First navigation link" });
    const last = screen.getByRole("button", { name: "Last navigation link" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Main content action", hidden: true }).closest(".lc-workspace-main"))
      .toHaveAttribute("inert");
    expect(first).toHaveFocus();

    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-sidebar")).not.toHaveClass("lc-workspace-sidebar-open");
    expect(screen.getByRole("button", { name: "Main content action" }).closest(".lc-workspace-main"))
      .not.toHaveAttribute("inert");
    expect(menuButton).toHaveFocus();
  });

  it("does not steal focus when mounted with an open compact drawer", () => {
    renderWorkspace(true);

    expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "First navigation link" })).not.toHaveFocus();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Close sidebar" }));
  });

  it("keeps the wide sidebar inline and toggleable without modal or inert semantics", () => {
    mockViewport(1280);
    renderWorkspace();

    const sidebar = screen.getByTestId("workspace-sidebar");
    const menuButton = screen.getByRole("button", { name: "Open sidebar" });
    expect(sidebar).not.toHaveClass("lc-workspace-sidebar-open");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(menuButton);
    expect(sidebar).toHaveClass("lc-workspace-sidebar-open");
    expect(sidebar).not.toHaveAttribute("aria-modal");
    expect(sidebar).not.toHaveAttribute("role", "dialog");
    expect(screen.getByRole("button", { name: "Main content action" }).closest(".lc-workspace-main"))
      .not.toHaveAttribute("inert");

    fireEvent.click(menuButton);
    expect(sidebar).not.toHaveClass("lc-workspace-sidebar-open");
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menuButton);
    expect(sidebar).toHaveClass("lc-workspace-sidebar-open");
  });
});
