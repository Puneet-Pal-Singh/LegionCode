import { describe, expect, it } from "vitest";
import {
  InMemoryEventRepository,
  MemoryContextRepository,
} from "@repo/persistence";
import { SessionMemoryClient } from "./SessionMemoryClient";
import type { Env } from "../../types/ai";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const EVENT_ID = "123e4567-e89b-42d3-a456-426614174001";

describe("SessionMemoryClient", () => {
  it("should append session memory through the canonical memory repository", async () => {
    const env = createEnv();
    const client = new SessionMemoryClient({
      env,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const firstAppend = await client.appendSessionMemory({
      eventId: EVENT_ID,
      idempotencyKey: "event-1",
      runId: RUN_ID,
      sessionId: SESSION_ID,
      scope: "session",
      kind: "fact",
      content: "Prefer concise implementation notes.",
      tags: ["preference"],
      confidence: 1,
      source: "user",
      createdAt: "2026-05-17T00:00:00.000Z",
    });
    const duplicateAppend = await client.appendSessionMemory({
      eventId: EVENT_ID,
      idempotencyKey: "event-1",
      runId: RUN_ID,
      sessionId: SESSION_ID,
      scope: "session",
      kind: "fact",
      content: "Prefer concise implementation notes.",
      tags: ["preference"],
      confidence: 1,
      source: "user",
      createdAt: "2026-05-17T00:00:00.000Z",
    });

    expect(firstAppend).toBe(true);
    expect(duplicateAppend).toBe(false);

    const context = await client.getSessionMemoryContext(
      SESSION_ID,
      "implementation notes",
    );
    expect(context.events).toHaveLength(1);
    expect(context.events[0]?.content).toContain("concise");
  });

  it("should store session snapshots as context snapshot metadata", async () => {
    const env = createEnv();
    const client = new SessionMemoryClient({
      env,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    await client.upsertSessionSnapshot({
      sessionId: SESSION_ID,
      summary: "User prefers concise notes.",
      constraints: ["keep context compact"],
      decisions: [],
      todos: ["finish PR7"],
      updatedAt: "2026-05-17T00:00:00.000Z",
      version: 1,
    });

    const snapshot = await client.getSessionSnapshot(SESSION_ID);

    expect(snapshot?.summary).toBe("User prefers concise notes.");
    expect(snapshot?.todos).toEqual(["finish PR7"]);
  });
});

function createEnv(): Env {
  return {
    AUTH_MEMORY_EVENT_REPOSITORY: new InMemoryEventRepository(),
    AUTH_CONTEXT_REPOSITORY: new MemoryContextRepository(),
  } as unknown as Env;
}
