import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../types/session";
import { ArchivedChatsSettings } from "./ArchivedChatsSettings";

const mockUseArchivedSessions = vi.fn();

vi.mock("../../hooks/useArchivedSessions", () => ({
  useArchivedSessions: (...args: unknown[]) => mockUseArchivedSessions(...args),
}));

function archivedSession(
  id: string,
  name: string,
  repository: string,
): AgentSession {
  return {
    id,
    name,
    repository,
    titleSource: "user",
    activeRunId: `run-${id}`,
    runIds: [`run-${id}`],
    status: "completed",
    pinnedAt: null,
    archivedAt: "2026-08-09T12:00:00.000Z",
    mode: "build",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
  };
}

describe("ArchivedChatsSettings", () => {
  beforeEach(() => {
    mockUseArchivedSessions.mockReturnValue({
      sessions: [
        archivedSession("1", "Fix model picker", "Puneet/shadowbox"),
        archivedSession("2", "Document agents", "Puneet/codex"),
      ],
      isLoading: false,
      error: null,
      removeSession: vi.fn(),
      deleteSession: vi.fn(async () => undefined),
      deleteAllSessions: vi.fn(async () => undefined),
    });
  });

  it("groups archived chats by project and filters the list", () => {
    render(
      <ArchivedChatsSettings
        isActive={true}
        onUnarchiveSession={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("heading", { name: "shadowbox" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "codex" })).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText("Search archived chats"), {
      target: { value: "model" },
    });
    expect(screen.getByText("Fix model picker")).toBeVisible();
    expect(screen.queryByText("Document agents")).not.toBeInTheDocument();
  });

  it("deletes one chat directly and confirms bulk deletion", async () => {
    const deleteSession = vi.fn(async () => undefined);
    const deleteAllSessions = vi.fn(async () => undefined);
    mockUseArchivedSessions.mockReturnValue({
      ...mockUseArchivedSessions(),
      deleteSession,
      deleteAllSessions,
    });
    render(
      <ArchivedChatsSettings
        isActive={true}
        onUnarchiveSession={vi.fn(async () => undefined)}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Delete Fix model picker" }),
      );
    });
    expect(deleteSession).toHaveBeenCalledWith("1");

    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(deleteAllSessions).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Confirm all" }),
      );
    });
    expect(deleteAllSessions).toHaveBeenCalledOnce();
  });
});
