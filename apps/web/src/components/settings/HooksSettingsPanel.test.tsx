import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  HookDefinition,
  HookDefinitionsClient,
} from "../../services/api/hookDefinitionsClient.js";
import { HooksSettingsPanel } from "./HooksSettingsPanel.js";

const userDefinition: HookDefinition = {
  handlerId: "personal.start",
  eventName: "SessionStart",
  source: "user",
  displayName: "Personal startup check",
  enabled: true,
  order: 1,
  timeoutMs: 500,
  configurationKey: "hooks.personal.start",
};

const projectDefinition: HookDefinition = {
  ...userDefinition,
  handlerId: "project.start",
  source: "project",
  displayName: "Project startup check",
};

describe("HooksSettingsPanel", () => {
  it("renders server definitions, allows only user toggles, and never exposes opaque configuration keys", async () => {
    const client: HookDefinitionsClient = {
      list: vi.fn(async () => [userDefinition, projectDefinition]),
      update: vi.fn(async (_workspaceId, definition) => definition),
      delete: vi.fn(async () => undefined),
    };

    render(
      <HooksSettingsPanel
        isActive={true}
        workspaceId="workspace_1"
        client={client}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /User config/ }));
    expect(screen.getByText("Personal startup check")).toBeInTheDocument();
    expect(screen.queryByText("hooks.personal.start")).not.toBeInTheDocument();

    const userToggle = screen.getByRole("switch", {
      name: "Disable Personal startup check",
    });
    fireEvent.click(userToggle);
    await waitFor(() =>
      expect(client.update).toHaveBeenCalledWith(
        "workspace_1",
        expect.objectContaining({
          handlerId: "personal.start",
          enabled: false,
        }),
      ),
    );
    expect(client.update).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Project config/ }));
    expect(screen.getByText("Project startup check")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: "Disable Project startup check",
      }),
    ).toBeDisabled();
  });

  it("requires a second explicit action before deleting a user hook", async () => {
    const client: HookDefinitionsClient = {
      list: vi.fn(async () => [userDefinition]),
      update: vi.fn(async (_workspaceId, definition) => definition),
      delete: vi.fn(async () => undefined),
    };
    render(
      <HooksSettingsPanel
        isActive={true}
        workspaceId="workspace_1"
        client={client}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /User config/ }));
    await screen.findByText("Personal startup check");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Personal startup check" }),
    );
    expect(client.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() =>
      expect(client.delete).toHaveBeenCalledWith(
        "workspace_1",
        "personal.start",
      ),
    );
  });
});
