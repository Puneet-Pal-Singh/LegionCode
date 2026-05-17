import { describe, expect, it } from "vitest";
import { MemoryContextRepository } from "./MemoryContextRepository.js";

describe("MemoryContextRepository", () => {
  const mockClock = { now: () => new Date("2025-01-01T00:00:00Z") };

  it("should create snapshot and list by session", async () => {
    const repo = new MemoryContextRepository(mockClock);

    const snapshot = await repo.createSnapshot({
      userId: "user-1",
      sessionId: "session-1",
      snapshotKind: "compaction",
      payloadSizeBytes: 128,
      triggerReason: "token_threshold",
      usageBeforeJson: { inputTokens: 1000 },
      usageAfterJson: { inputTokens: 250 },
      validationJson: { ok: true },
      modelInfoJson: { provider: "openai", model: "gpt-5" },
      mediaArtifactsJson: [],
      continuityStateJson: { phase: "execution" },
    });

    expect(snapshot.id).toBeTruthy();
    expect(snapshot.snapshotKind).toBe("compaction");
    expect(snapshot.triggerReason).toBe("token_threshold");
    expect(snapshot.usageBeforeJson).toEqual({ inputTokens: 1000 });

    const snapshots = await repo.listSnapshotsBySession("session-1");
    expect(snapshots).toHaveLength(1);
  });

  it("should add and list sources", async () => {
    const repo = new MemoryContextRepository(mockClock);

    const snapshot = await repo.createSnapshot({
      userId: "user-1",
      sessionId: "session-1",
      snapshotKind: "checkpoint",
    });

    const source = await repo.addSource({
      contextSnapshotId: snapshot.id,
      sourceType: "message",
      sourceId: "msg-1",
    });

    expect(source.id).toBeTruthy();
    expect(source.sourceType).toBe("message");

    const sources = await repo.listSourcesBySnapshot(snapshot.id);
    expect(sources).toHaveLength(1);
  });

  it("should scope sources by snapshot owner", async () => {
    const repo = new MemoryContextRepository(mockClock);

    const snapshot = await repo.createSnapshot({
      userId: "user-1",
      sessionId: "session-1",
      snapshotKind: "checkpoint",
    });
    await repo.addSource({
      contextSnapshotId: snapshot.id,
      sourceType: "message",
      sourceId: "msg-1",
    });

    expect(await repo.listSourcesBySnapshot(snapshot.id, "user-1")).toHaveLength(1);
    expect(await repo.listSourcesBySnapshot(snapshot.id, "user-2")).toHaveLength(0);
  });

  it("should reject sources for missing snapshots", async () => {
    const repo = new MemoryContextRepository(mockClock);

    await expect(
      repo.addSource({
        contextSnapshotId: "missing",
        sourceType: "message",
        sourceId: "msg-1",
      }),
    ).rejects.toThrow("Context snapshot not found: missing");
  });

  it("should support transaction", async () => {
    const repo = new MemoryContextRepository(mockClock);

    const result = await repo.transaction(async (txRepo) => {
      return await txRepo.createSnapshot({
        userId: "user-1",
        sessionId: "session-1",
        snapshotKind: "compaction",
      });
    });

    expect(result.id).toBeTruthy();
  });
});
