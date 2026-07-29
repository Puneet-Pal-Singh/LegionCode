import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

const mockUseProviderStore = vi.fn();

vi.mock("../../hooks/useProviderStore.js", () => ({
  useProviderStore: (...args: unknown[]) => mockUseProviderStore(...args),
}));

describe("SettingsDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseProviderStore.mockReturnValue({
      status: "ready",
      error: null,
      catalog: [
        {
          providerId: "openai",
          displayName: "OpenAI",
          authModes: ["api_key"],
          launchStage: "supported",
        },
      ],
      credentials: [],
      connectCredential: vi.fn(async () => undefined),
      disconnectCredential: vi.fn(async () => undefined),
      manageProviderModels: {},
      visibleModelIds: {},
      loadingManageModelsForProviderIds: {},
      loadManageProviderModels: vi.fn(async () => []),
      toggleModelVisibility: vi.fn(),
      setProviderVisibleModels: vi.fn(),
    });
  });

  it("persists the context-window composer preference", () => {
    render(
      <SettingsDialog
        isOpen={true}
        onClose={vi.fn()}
        initialSection="general"
      />,
    );

    const toggle = screen.getByRole("checkbox", {
      name: /show context window usage/i,
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem("legioncode:composer-preferences")).toContain(
      '"showContextWindowUsage":false',
    );
  });

  it("switches between General, Connect, Models, and Hooks sections", () => {
    render(
      <SettingsDialog
        isOpen={true}
        onClose={vi.fn()}
        initialSection="general"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(
      screen.getByRole("heading", { name: "Providers" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Connected providers" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hooks" }));
    expect(screen.getByRole("heading", { name: "Hooks" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Open a task with a server-owned workspace before managing its hooks.",
      ),
    ).toBeInTheDocument();
  });

  it("opens directly to connect-provider flow when initial section is connect", () => {
    render(
      <SettingsDialog
        isOpen={true}
        onClose={vi.fn()}
        initialSection="connect"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Providers" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Connected providers" }),
    ).toBeInTheDocument();
  });

  it("opens connect api-key input when provider connect is clicked", () => {
    render(
      <SettingsDialog
        isOpen={true}
        onClose={vi.fn()}
        initialSection="connect"
      />,
    );

    const connectButtons = screen.getAllByRole("button", { name: "Connect" });
    fireEvent.click(connectButtons[connectButtons.length - 1]!);
    expect(
      screen.getByRole("heading", { name: "Connect Provider" }),
    ).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <SettingsDialog
        isOpen={true}
        onClose={onClose}
        initialSection="general"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
