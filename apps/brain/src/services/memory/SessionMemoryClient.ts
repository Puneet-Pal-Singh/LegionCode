import {
  MemoryEventSchema,
  MemorySnapshotSchema,
  type MemoryEvent,
  type MemorySnapshot,
} from "@shadowbox/execution-engine/runtime";
import type { JsonValue } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { withContextRepository } from "../context/ContextPersistenceFactory";
import { withMemoryEventRepository } from "./MemoryPersistenceFactory";

const SESSION_MEMORY_SNAPSHOT_KIND = "session_memory";

export interface SessionMemoryClientDependencies {
  env: Env;
  userId: string;
  sessionId: string;
}

export class SessionMemoryClient {
  constructor(private readonly deps: SessionMemoryClientDependencies) {}

  async appendSessionMemory(event: MemoryEvent): Promise<boolean> {
    const validated = MemoryEventSchema.parse(event);
    if (validated.scope !== "session") {
      throw new Error("SessionMemoryClient only accepts session-scoped events");
    }

    const existing = await this.findExistingEvent(validated.idempotencyKey);
    if (existing) {
      return false;
    }

    await withMemoryEventRepository(this.deps.env, async (repository) => {
      await repository.appendEvent({
        userId: this.deps.userId,
        sessionId: validated.sessionId,
        runId: validated.runId,
        eventType: `${validated.scope}:${validated.kind}`,
        payload: validated as JsonValue,
        idempotencyKey: validated.idempotencyKey,
      });
    });

    return true;
  }

  async getSessionMemoryContext(
    sessionId: string,
    prompt: string,
    limit?: number,
  ): Promise<{
    events: MemoryEvent[];
    snapshot?: MemorySnapshot;
  }> {
    const [events, snapshot] = await Promise.all([
      this.getSessionEvents(sessionId, prompt, limit),
      this.getSessionSnapshot(sessionId),
    ]);

    return { events, snapshot };
  }

  async getSessionSnapshot(
    sessionId: string,
  ): Promise<MemorySnapshot | undefined> {
    const snapshots = await withContextRepository(
      this.deps.env,
      async (repository) =>
        await repository.listSnapshotsBySession(sessionId, this.deps.userId),
    );

    const snapshot = snapshots.find(
      (record) => record.snapshotKind === SESSION_MEMORY_SNAPSHOT_KIND,
    );
    if (!snapshot?.continuityStateJson) {
      return undefined;
    }

    const parsed = MemorySnapshotSchema.safeParse(snapshot.continuityStateJson);
    return parsed.success ? parsed.data : undefined;
  }

  async upsertSessionSnapshot(snapshot: MemorySnapshot): Promise<void> {
    const validated = MemorySnapshotSchema.parse(snapshot);

    await withContextRepository(this.deps.env, async (repository) => {
      await repository.createSnapshot({
        userId: this.deps.userId,
        sessionId: validated.sessionId,
        runId: validated.runId ?? null,
        snapshotKind: SESSION_MEMORY_SNAPSHOT_KIND,
        payloadSizeBytes: byteLength(JSON.stringify(validated)),
        tokenCount: estimateSnapshotTokens(validated),
        triggerReason: "memory_compaction",
        continuityStateJson: validated as JsonValue,
      });
    });
  }

  async getSessionMemoryStats(sessionId: string): Promise<{
    eventCount: number;
    hasSnapshot: boolean;
  }> {
    const [events, snapshot] = await Promise.all([
      this.getSessionEvents(sessionId, "", undefined),
      this.getSessionSnapshot(sessionId),
    ]);

    return {
      eventCount: events.length,
      hasSnapshot: !!snapshot,
    };
  }

  async clearSessionMemory(): Promise<void> {
    throw new Error("Session memory is append-only and cannot be cleared");
  }

  private async findExistingEvent(
    idempotencyKey: string,
  ): Promise<MemoryEvent | undefined> {
    const events = await withMemoryEventRepository(
      this.deps.env,
      async (repository) =>
        await repository.listEventsBySession(
          this.deps.sessionId,
          this.deps.userId,
        ),
    );

    const existing = events.find(
      (event) => event.idempotencyKey === idempotencyKey,
    );
    if (!existing?.payload) {
      return undefined;
    }

    const parsed = MemoryEventSchema.safeParse(existing.payload);
    return parsed.success ? parsed.data : undefined;
  }

  private async getSessionEvents(
    sessionId: string,
    prompt: string,
    limit?: number,
  ): Promise<MemoryEvent[]> {
    const records = await withMemoryEventRepository(
      this.deps.env,
      async (repository) =>
        await repository.listEventsBySession(sessionId, this.deps.userId),
    );

    return records
      .map((record) => MemoryEventSchema.safeParse(record.payload))
      .filter((result) => result.success)
      .map((result) => result.data)
      .sort((left, right) => scoreEvent(right, prompt) - scoreEvent(left, prompt))
      .slice(0, limit);
  }
}

function estimateSnapshotTokens(snapshot: MemorySnapshot): number {
  return estimateTokens(
    [
      snapshot.summary,
      ...snapshot.constraints,
      ...snapshot.decisions,
      ...snapshot.todos,
    ].join("\n"),
  );
}

function scoreEvent(event: MemoryEvent, prompt: string): number {
  if (!prompt.trim()) {
    return new Date(event.createdAt).getTime();
  }

  const contentWords = new Set(event.content.toLowerCase().split(/\s+/));
  const promptWords = new Set(prompt.toLowerCase().split(/\s+/));
  let matches = 0;

  for (const word of promptWords) {
    if (word.length > 3 && contentWords.has(word)) {
      matches += 1;
    }
  }

  return matches * 10 + event.confidence;
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
