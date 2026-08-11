import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarShell } from "./SidebarShell";

describe("SidebarShell", () => {
  it("places the sidebar identity before the collapse control", () => {
    render(
      <SidebarShell
        header={<span>LegionCode</span>}
        utility={<button type="button">New task</button>}
        onClose={() => undefined}
      >
        <div>Tasks</div>
      </SidebarShell>,
    );

    const header = screen.getByText("LegionCode");
    const collapse = screen.getByRole("button", { name: "Close sidebar" });
    expect(
      header.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the utility divider only after the task content scrolls", () => {
    const { container } = render(
      <SidebarShell utility={<button type="button">New task</button>}>
        <div>Tasks</div>
      </SidebarShell>,
    );

    const utility = screen.getByTestId("sidebar-utility");
    const content = container.querySelector(".overflow-y-auto");
    expect(utility).toHaveAttribute("data-content-scrolled", "false");
    expect(utility).not.toHaveClass("border-b");

    Object.defineProperty(content, "scrollTop", {
      configurable: true,
      value: 8,
    });
    fireEvent.scroll(content as Element);

    expect(utility).toHaveAttribute("data-content-scrolled", "true");
    expect(utility).toHaveClass("border-b");
  });
});
