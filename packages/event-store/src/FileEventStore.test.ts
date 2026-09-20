import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@repo/platform-protocol";

import { FileEventStore } from "./FileEventStore.js";
import type { AppendEventInput } from "./types.js";

const THREAD_ID = ThreadIdSchema.parse("thr_localthread");
const WORKSPACE_ID = WorkspaceIdSchema.parse("wrk_localworkspace");
const USER_ID = UserIdSchema.parse("usr_localdesktop");

describe("FileEventStore", () => {
  it("replays the same event after a store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "legioncode-events-"));
    const filePath = join(directory, "events.json");
    try {
      const first = new FileEventStore(filePath);
      const appended = await first.append(createThreadEvent());
      const reopened = new FileEventStore(filePath);

      await expect(
        reopened.replay({
          scope: { scopeType: "thread", scopeId: THREAD_ID },
          afterCursor: null,
          limit: 10,
        }),
      ).resolves.toMatchObject({ events: [appended], nextCursor: appended.cursor });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not expose an event in memory when the atomic write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "legioncode-events-"));
    const blockedDirectory = join(directory, "blocked");
    const filePath = join(blockedDirectory, "events.json");
    try {
      const store = new FileEventStore(filePath);
      await expect(store.listAll()).resolves.toEqual([]);
      await writeFile(blockedDirectory, "not-a-directory");
      await expect(store.append(createThreadEvent())).rejects.toThrow();
      await rm(blockedDirectory);
      await mkdir(blockedDirectory);
      await expect(store.replay({
        scope: { scopeType: "thread", scopeId: THREAD_ID },
        afterCursor: null,
        limit: 10,
      })).resolves.toMatchObject({ events: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createThreadEvent(): AppendEventInput {
  const timestamp = "2026-09-20T00:00:00.000Z";
  return {
    threadId: THREAD_ID,
    workspaceId: WORKSPACE_ID,
    runId: null,
    scopeType: "thread",
    scopeId: THREAD_ID,
    type: "thread.created",
    payload: {
      thread: {
        id: THREAD_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        title: "Local thread",
        titleSource: "user",
        titleVersion: 1,
        titleStatus: "ready",
        lastTerminalTurnId: null,
        status: "active",
        pinnedAt: null,
        archivedAt: null,
        activeRunId: null,
        activeLeafItemId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastEventSequence: 1,
      },
    },
    idempotencyKey: "thread-created:thr_localthread",
    producer: { kind: "control_plane", id: "test" },
    schemaVersion: EVENT_SCHEMA_VERSION,
  };
}
