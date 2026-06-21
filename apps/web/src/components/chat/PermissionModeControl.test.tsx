import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PRODUCT_MODES } from "@repo/shared-types";
import { PermissionModeControl } from "./PermissionModeControl";

describe("PermissionModeControl", () => {
  it("shows the current permission selection", () => {
    render(
      <PermissionModeControl
        value={PRODUCT_MODES.AUTO_FOR_SAFE}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toHaveTextContent("Auto edits");
  });

  it("lets users switch from auto edits to full access", () => {
    const onChange = vi.fn();
    render(
      <PermissionModeControl
        value={PRODUCT_MODES.AUTO_FOR_SAFE}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /full access/i }),
    );

    expect(onChange).toHaveBeenCalledWith(PRODUCT_MODES.FULL_AGENT);
    expect(
      screen.queryByTestId("permission-mode-menu"),
    ).not.toBeInTheDocument();
  });

  it("shows a distinct label for same-repo auto mode", () => {
    render(
      <PermissionModeControl
        value={PRODUCT_MODES.AUTO_FOR_SAME_REPO}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toHaveTextContent("Auto repo");
  });

  it("can open below the welcome composer control", () => {
    render(
      <PermissionModeControl
        value={PRODUCT_MODES.AUTO_FOR_SAFE}
        onChange={vi.fn()}
        menuPlacement="below"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    expect(screen.getByTestId("permission-mode-menu")).toHaveClass("top-full");
  });

  it("closes the menu and blocks changes when disabled while open", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PermissionModeControl
        value={PRODUCT_MODES.AUTO_FOR_SAFE}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    expect(screen.getByTestId("permission-mode-menu")).toBeInTheDocument();

    rerender(
      <PermissionModeControl
        value={PRODUCT_MODES.AUTO_FOR_SAFE}
        onChange={onChange}
        disabled
      />,
    );

    expect(
      screen.queryByTestId("permission-mode-menu"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Permission mode" }),
    ).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
