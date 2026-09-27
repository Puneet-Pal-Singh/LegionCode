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

    expect(
      Object.fromEntries(
        entries.map(({ selectionId, displayStatus }) => [
          selectionId,
          displayStatus,
        ]),
      ),
    ).toEqual({
      approval: "waiting_for_approval",
      running: "running",
      paused: "paused",
      completed: "completed",
      failed: "failed",
    });
    expect(
      entries.find((entry) => entry.selectionId === "completed")?.isUnread,
    ).toBe(true);
    expect(selectSessionUnread(sessions[3]!)).toBe(true);
  });

  it("keeps archived, pinned, and selected identity in the SDK projection", () => {
    const model = projectAgentSessionsForSidebar({
      sessions: [
        createSession({ id: "selected" }),
        createSession({ id: "pinned", pinnedAt: "2026-09-26T11:00:00.000Z" }),
        createSession({
          id: "archived",
          archivedAt: "2026-09-26T11:00:00.000Z",
        }),
      ],
      repositories: ["acme/repo"],
      activeSessionId: "selected",
      hydrationStatus: "ready",
      now: NOW,
    });

    expect(
      model.workspaceGroups
        .flatMap((group) => group.threads)
        .map((thread) => [thread.selectionId, thread.isSelected]),
    ).toContainEqual(["selected", true]);
    expect(model.pinned.map((thread) => thread.selectionId)).toEqual([
      "pinned",
    ]);
    expect(model.archived.map((thread) => thread.selectionId)).toEqual([
      "archived",
    ]);
  });

  it("preserves Web UUID selection identity without inventing a canonical thread id", () => {
    const sessionId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const model = projectAgentSessionsForSidebar({
      sessions: [createSession({ id: sessionId })],
      repositories: ["acme/repo"],
      activeSessionId: sessionId,
      hydrationStatus: "ready",
      now: NOW,
    });
    const thread = model.workspaceGroups.flatMap((group) => group.threads)[0];

    expect(thread?.selectionId).toBe(sessionId);
    expect(thread?.threadId).toBeNull();
    expect(thread?.isSelected).toBe(true);
    expect(model.selectedSelectionId).toBe(sessionId);
  });

  it("keeps repository names distinct when normalized workspace ids would collide", () => {
    const model = projectAgentSessionsForSidebar({
      sessions: [
        createSession({ id: "session-a", repository: "acme/foo_bar" }),
        createSession({ id: "session-b", repository: "acme_foo/bar" }),
      ],
      repositories: ["acme/foo_bar", "acme_foo/bar"],
      activeSessionId: null,
      hydrationStatus: "ready",
      now: NOW,
    });

    expect(
      model.workspaceGroups.map((group) => [
        group.workspaceSelectionId,
        group.workspaceId,
        group.threads.map((thread) => thread.selectionId),
      ]),
    ).toEqual([
      ["acme_foo/bar", null, ["session-b"]],
      ["acme/foo_bar", null, ["session-a"]],
    ]);
  });

  it("keeps loading and failed hydration visible as source state", () => {
    const input = {
      sessions: [],
      repositories: [],
      activeSessionId: null,
      now: NOW,
    };
    expect(
      projectAgentSessionsForSidebar({ ...input, hydrationStatus: "loading" })
        .status,
    ).toBe("loading");
    expect(
      projectAgentSessionsForSidebar({ ...input, hydrationStatus: "failed" })
        .status,
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
