import { describe, expect, it } from "vitest";
import type { AgentSession } from "../types/session.js";
import { mergeServerSessionProjection } from "./session-title-ordering.js";

function createSession(
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id: "session-1",
    name: "Preview title",
    titleSource: "preview",
    titleVersion: 1,
    repository: null,
    activeRunId: "run-session-1",
    runIds: ["run-session-1"],
    status: "idle",
    pinnedAt: null,
    archivedAt: null,
    mode: "build",
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("mergeServerSessionProjection", () => {
  it("keeps a local user rename when stale generated replay arrives", () => {
    const current = createSession({
      name: "My chosen title",
      titleSource: "user",
      titleVersion: 2,
      updatedAt: "2026-07-18T10:01:00.000Z",
    });
    const incoming = createSession({
      name: "Generated title",
      titleSource: "generated",
      titleVersion: 3,
      status: "running",
      updatedAt: "2026-07-18T10:02:00.000Z",
    });

    expect(mergeServerSessionProjection(current, incoming)).toMatchObject({
      name: "My chosen title",
      titleSource: "user",
      titleVersion: 2,
      status: "running",
    });
  });

  it("accepts a newer server-generated title over an older preview", () => {
    const current = createSession({ titleVersion: 1 });
    const incoming = createSession({
      name: "Generated title",
      titleSource: "generated",
      titleVersion: 2,
    });

    expect(mergeServerSessionProjection(current, incoming)).toBe(incoming);
  });
});
