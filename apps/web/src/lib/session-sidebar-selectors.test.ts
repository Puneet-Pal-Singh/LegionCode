import { describe, expect, it } from "vitest";
import type { AgentSession } from "../types/session";
import {
  projectAgentSessionsForSidebar,
  selectSessionUnread,
} from "./session-sidebar-selectors";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

describe("Web session to shared Thread sidebar projection", () => {
  it("maps approval, running, paused, and recent unread terminal states", () => {
    const sessions = [
      createSession({ id: "approval", status: "waiting_for_approval" }),
      createSession({ id: "running", status: "running" }),
      createSession({ id: "paused", status: "paused" }),
      createSession({
        id: "completed",
        status: "completed",
        updatedAt: new Date(NOW - 60_000).toISOString(),
        lastTerminalTurnId: "turn-completed",
        lastAcknowledgedTerminalTurnId: null,
      }),
      createSession({
        id: "failed",
        status: "failed",
        updatedAt: new Date(NOW - 60_000).toISOString(),
        lastTerminalTurnId: "turn-failed",
        lastAcknowledgedTerminalTurnId: null,
      }),
    ];
    const model = projectAgentSessionsForSidebar({
      sessions,
      repositories: ["acme/repo"],
      activeSessionId: null,
      hydrationStatus: "ready",
      now: NOW,
    });
    const entries = model.workspaceGroups.flatMap((group) => group.threads);

    expect(Object.fromEntries(entries.map(({ threadId, displayStatus }) => [threadId, displayStatus]))).toEqual({
      approval: "waiting_for_approval",
      running: "running",
      paused: "paused",
      completed: "completed",
      failed: "failed",
    });
    expect(entries.find((entry) => entry.threadId === "completed")?.isUnread).toBe(true);
    expect(selectSessionUnread(sessions[3]!)).toBe(true);
  });

  it("keeps archived, pinned, and selected identity in the SDK projection", () => {
    const model = projectAgentSessionsForSidebar({
      sessions: [
        createSession({ id: "selected" }),
        createSession({ id: "pinned", pinnedAt: "2026-09-26T11:00:00.000Z" }),
        createSession({ id: "archived", archivedAt: "2026-09-26T11:00:00.000Z" }),
      ],
      repositories: ["acme/repo"],
      activeSessionId: "selected",
      hydrationStatus: "ready",
      now: NOW,
    });

    expect(model.workspaceGroups.flatMap((group) => group.threads).map((thread) => [thread.threadId, thread.isSelected])).toContainEqual(["selected", true]);
    expect(model.pinned.map((thread) => thread.threadId)).toEqual(["pinned"]);
    expect(model.archived.map((thread) => thread.threadId)).toEqual(["archived"]);
  });

  it("keeps loading and failed hydration visible as source state", () => {
    const input = {
      sessions: [],
      repositories: [],
      activeSessionId: null,
      now: NOW,
    };
    expect(
      projectAgentSessionsForSidebar({ ...input, hydrationStatus: "loading" }).status,
    ).toBe("loading");
    expect(
      projectAgentSessionsForSidebar({ ...input, hydrationStatus: "failed" }).status,
    ).toBe("error");
  });
});

function createSession(overrides: Partial<AgentSession> = {}): AgentSession {
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
    createdAt: "2026-09-25T12:00:00.000Z",
    updatedAt: "2026-09-26T11:00:00.000Z",
    ...overrides,
  };
}
