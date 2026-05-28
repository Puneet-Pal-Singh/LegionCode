import { describe, expect, it } from "vitest";
import type { AgentSession } from "../types/session";
import {
  groupSessionsByRepository,
  selectPinnedSessions,
  selectVisibleSessions,
} from "./session-sidebar-selectors";

describe("session sidebar selectors", () => {
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
    updatedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}
