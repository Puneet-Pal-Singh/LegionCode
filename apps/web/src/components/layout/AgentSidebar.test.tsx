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

function renderSidebar(overrides: Partial<React.ComponentProps<typeof AgentSidebar>> = {}) {
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
    expect(screen.queryByRole("option", { name: "Draft task" })).not.toBeInTheDocument();
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
});
