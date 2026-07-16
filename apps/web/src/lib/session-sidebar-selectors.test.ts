import { describe, expect, it } from "vitest";
import type { AgentSession } from "../types/session";
import {
  groupSessionsByRepository,
  selectPinnedSessions,
  selectSessionActive,
  selectSessionUnread,
  selectVisibleSessions,
} from "./session-sidebar-selectors";

describe("session sidebar selectors", () => {
  it("derives unread from durable terminal turn and read receipt", () => {
    const session = createSession({
      lastTerminalTurnId: "turn-2",
      lastAcknowledgedTerminalTurnId: "turn-1",
    });
    expect(selectSessionUnread(session)).toBe(true);
    expect(
      selectSessionUnread({ ...session, lastAcknowledgedTerminalTurnId: "turn-2" }),
    ).toBe(false);
  });

  it("derives activity from active turn status, not title status", () => {
    const session = createSession({ status: "running", titleStatus: "ready" });
    expect(selectSessionActive(session)).toBe(true);
    expect(
      selectSessionActive({ ...session, status: "completed", titleStatus: "pending" }),
    ).toBe(false);
  });

  it("filters archived sessions and keeps pinned sessions out of repository groups", () => {
    const sessions = [
      createSession({ id: "pinned", pinnedAt: "2026-05-15T00:00:02.000Z" }),
      createSession({ id: "normal", updatedAt: "2026-05-15T00:00:03.000Z" }),
      createSession({ id: "archived", archivedAt: "2026-05-15T00:00:04.000Z" }),
    ];

    expect(
      selectVisibleSessions(sessions).map((session) => session.id),
    ).toEqual(["pinned", "normal"]);
    expect(selectPinnedSessions(sessions).map((session) => session.id)).toEqual(
      ["pinned"],
    );
    expect(
      groupSessionsByRepository(sessions)[0]?.sessions.map(
        (session) => session.id,
      ),
    ).toEqual(["normal"]);
  });
});

function createSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "session",
    name: "Session",
    titleSource: "generated",
    repository: "acme/repo",
    activeRunId: "run",
    runIds: ["run"],
    status: "idle",
    mode: "build",
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}
