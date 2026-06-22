import {
  ArtifactIdSchema,
  TurnIdSchema,
  type TurnDiffPayload,
  type TurnWorkspaceSnapshot,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "./InMemoryArtifactStore.js";
import { DefaultTurnArtifactStore } from "./TurnArtifactStore.js";
import {
  ArtifactAccessContextSchema,
  ArtifactOwnershipSchema,
  type ArtifactAuthorizer,
} from "./types.js";

const TURN_ID = TurnIdSchema.parse("trn_artifact001");
const access = ArtifactAccessContextSchema.parse({
  userId: "usr_artifact001",
  workspaceId: "wrk_artifact001",
  threadId: "thr_artifact001",
  runId: "run_artifact001",
});
const ownership = ArtifactOwnershipSchema.parse({
  createdBy: access.userId,
  workspaceId: access.workspaceId,
  threadId: access.threadId,
  runId: access.runId,
});

describe("DefaultTurnArtifactStore", () => {
  it("persists and reads immutable snapshots and a multi-file turn diff", async () => {
    const store = createStore();
    const start = snapshot("start", "a");
    const terminal = snapshot("terminal", "b");
    const diff = turnDiff(start, terminal);

    await store.putSnapshot({ snapshot: start, ownership, access });
    await store.putSnapshot({ snapshot: terminal, ownership, access });
    const metadata = await store.putTurnDiff({ diff, ownership, access });

    await expect(store.getTurnDiff(TURN_ID, access)).resolves.toEqual({
      metadata,
      payload: diff,
    });
    await expect(store.listWorkspaceDiffs(access)).resolves.toHaveLength(1);
  });

  it("persists an explicit empty diff idempotently", async () => {
    const store = createStore();
    const start = snapshot("start", "c");
    const terminal = snapshot("terminal", "c");
    const diff = { ...turnDiff(start, terminal), files: [], patch: "" };

    const first = await store.putTurnDiff({ diff, ownership, access });
    const retry = await store.putTurnDiff({ diff, ownership, access });

    expect(retry.artifactId).toBe(first.artifactId);
    await expect(store.getTurnDiff(TURN_ID, access)).resolves.toMatchObject({
      payload: { files: [], patch: "" },
    });
  });
});

function createStore(): DefaultTurnArtifactStore {
  let sequence = 0;
  const authorizer: ArtifactAuthorizer = { authorize: async () => true };
  const artifacts = new InMemoryArtifactStore({
    authorizer,
    createArtifactId: () => {
      sequence += 1;
      return ArtifactIdSchema.parse(
        `art_turn${String(sequence).padStart(6, "0")}`,
      );
    },
  });
  return new DefaultTurnArtifactStore(artifacts);
}

function snapshot(
  phase: TurnWorkspaceSnapshot["phase"],
  objectCharacter: string,
): TurnWorkspaceSnapshot {
  return {
    turnId: TURN_ID,
    snapshotKey: `artifact001_${phase}`,
    treeId: objectCharacter.repeat(40),
    headSha: "f".repeat(40),
    phase,
    capturedAt:
      phase === "start"
        ? "2026-06-21T00:00:00.000Z"
        : "2026-06-21T00:01:00.000Z",
  };
}

function turnDiff(
  startSnapshot: TurnWorkspaceSnapshot,
  terminalSnapshot: TurnWorkspaceSnapshot,
): TurnDiffPayload {
  return {
    turnId: TURN_ID,
    startSnapshot,
    terminalSnapshot,
    files: [
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 3,
        deletions: 1,
      },
      {
        path: "src/new.ts",
        previousPath: null,
        status: "added",
        additions: 5,
        deletions: 0,
      },
    ],
    patch: "diff --git a/src/app.ts b/src/app.ts\n",
  };
}
