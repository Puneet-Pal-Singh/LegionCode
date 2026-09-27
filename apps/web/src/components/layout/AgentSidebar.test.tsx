import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../types/session";
import { AgentSidebar } from "./AgentSidebar";

function createSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "session-1",
    name: "Draft task",
    titleSource: "generated",
    repository: "legioncode/legioncode",
    activeRunId: "run-1",
    runIds: ["run-1"],
    status: "running",
    mode: "build",
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-04-14T11:00:00.000Z",
    updatedAt: "2026-04-14T12:00:00.000Z",
    ...overrides,
  };
}

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof AgentSidebar>> = {},
) {
  return render(
    <AgentSidebar
      sessions={[createSession()]}
      repositories={["legioncode/legioncode"]}
      activeSessionId="session-1"
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onArchive={vi.fn()}
      onAddRepository={vi.fn()}
      onOpenSettings={vi.fn()}
      {...overrides}
    />,
  );
}

describe("AgentSidebar adapter", () => {
  it("routes selection and grouped creation back to existing Web actions", () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    renderSidebar({ onSelect, onCreate });

    fireEvent.click(screen.getByRole("option", { name: "Draft task" }));
    expect(onSelect).toHaveBeenCalledWith("session-1");
    fireEvent.click(
      screen.getByRole("button", { name: "New thread in legioncode" }),
    );
    expect(onCreate).toHaveBeenCalledWith("legioncode/legioncode");
  });

  it("routes a UUID selection back to Web unchanged", () => {
    const sessionId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const onSelect = vi.fn();
    renderSidebar({
      sessions: [createSession({ id: sessionId })],
      activeSessionId: sessionId,
      onSelect,
    });

    fireEvent.click(screen.getByRole("option", { name: "Draft task" }));
    expect(onSelect).toHaveBeenCalledWith(sessionId);
  });

  it("uses shared search and archive confirmation callbacks", async () => {
    const onArchive = vi.fn();
    renderSidebar({
      sessions: [
        createSession(),
        createSession({ id: "session-2", name: "Other task" }),
      ],
      onArchive,
    });

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "other" },
    });
    expect(
      screen.queryByRole("option", { name: "Draft task" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive Other task" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm archive for Other task" }),
    );
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith("session-2"));
  });

  it("preserves the authenticated account footer actions", () => {
    const onOpenSettings = vi.fn();
    renderSidebar({ onOpenSettings });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("routes colliding repository workspace actions to their raw repository identities", () => {
    const firstRepository = "acme/foo_bar";
    const secondRepository = "acme_foo/bar";
    const onCreate = vi.fn();
    const onRenameRepository = vi.fn();
    const onRemoveRepository = vi.fn();
    renderSidebar({
      sessions: [
        createSession({
          id: "session-a",
          name: "First repository task",
          repository: firstRepository,
        }),
        createSession({
          id: "session-b",
          name: "Second repository task",
          repository: secondRepository,
        }),
      ],
      repositories: [firstRepository, secondRepository],
      onCreate,
      onRenameRepository,
      onRemoveRepository,
    });

    expect(
      screen.getByRole("option", { name: "First repository task" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Second repository task" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New thread in bar" }));
    expect(onCreate).toHaveBeenCalledWith(secondRepository);
    fireEvent.click(
      screen.getByRole("button", { name: "Rename workspace bar" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Rename bar" }), {
      target: { value: "renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRenameRepository).toHaveBeenCalledWith(
      secondRepository,
      "renamed",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove workspace bar" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onRemoveRepository).toHaveBeenCalledWith(secondRepository);
  });

  it("keeps create and selection for No repository without showing manage actions", () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const onRenameRepository = vi.fn();
    const onRemoveRepository = vi.fn();
    renderSidebar({
      sessions: [
        createSession({
          id: "unscoped",
          name: "Unscoped task",
          repository: null,
        }),
      ],
      repositories: [],
      activeSessionId: "unscoped",
      onSelect,
      onCreate,
      onRenameRepository,
      onRemoveRepository,
    });

    expect(
      screen.getByRole("button", { name: "Toggle No repository" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rename workspace No repository" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove workspace No repository" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "New thread in No repository" }),
    );
    expect(onCreate).toHaveBeenCalledWith(undefined);
    fireEvent.click(screen.getByRole("option", { name: "Unscoped task" }));
    expect(onSelect).toHaveBeenCalledWith("unscoped");
    expect(onRenameRepository).not.toHaveBeenCalled();
    expect(onRemoveRepository).not.toHaveBeenCalled();
  });
});
