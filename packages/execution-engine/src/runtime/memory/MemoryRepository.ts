// RECONSTRUCTABILITY: Memory events, snapshots, and checkpoints in DO
// storage are the live runtime working set during execution. The canonical
// event log is in Postgres via PostgresMemoryEventRepository. If DO storage
// is lost, active run memory context is lost (run will fail), but committed
// memory events can be replayed from Postgres. Idempotency keys are ephemeral
// and safe to lose (retry will re-deduplicate against Postgres).
// TTL: Idempotency keys have no storage-level TTL but are cleaned up by
// clearRunMemory() at end of each run. Session-scoped keys persist for the
// DO lifetime.

import { z } from "zod";
import type { RuntimeDurableObjectState } from "../types.js";
import {
  MemoryEventSchema,
  type MemoryEvent,
  type MemorySnapshot,
  MemorySnapshotSchema,
  type ReplayCheckpoint,
  ReplayCheckpointSchema,
  type MemoryScope,
} from "./types.js";

export interface MemoryRepositoryDependencies {
  ctx: RuntimeDurableObjectState;
}

export class MemoryRepository {
  private ctx: RuntimeDurableObjectState;

  constructor(deps: MemoryRepositoryDependencies) {
    this.ctx = deps.ctx;
  }

  private getEventsKey(id: string, scope: MemoryScope): string {
    return scope === "run"
      ? `run:${id}:memory:events`
      : `session:${id}:memory:events`;
  }

  private getSnapshotKey(id: string, scope: MemoryScope): string {
    return scope === "run"
      ? `run:${id}:memory:snapshot`
      : `session:${id}:memory:snapshot`;
  }

  private getIdempotencyKey(
    id: string,
    idempotencyKey: string,
    scope: MemoryScope,
  ): string {
    return scope === "run"
      ? `run:${id}:memory:idempotency:${idempotencyKey}`
      : `session:${id}:memory:idempotency:${idempotencyKey}`;
  }

  private getCheckpointKey(runId: string, sequence: number): string {
    return `run:${runId}:memory:checkpoint:${sequence}`;
  }

  async appendEvent(event: MemoryEvent): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const id = event.scope === "run" ? event.runId : event.sessionId;
      const idempotencyKey = this.getIdempotencyKey(
        id,
        event.idempotencyKey,
        event.scope,
      );

      const existing = await this.ctx.storage.get<string>(idempotencyKey);
      if (existing) {
        return false;
      }

      const validated = MemoryEventSchema.parse(event);
      const eventsKey = this.getEventsKey(id, event.scope);

      const events =
        (await this.ctx.storage.get<MemoryEvent[]>(eventsKey)) ?? [];
      events.push(validated);

      await this.ctx.storage.put(eventsKey, events);
      await this.ctx.storage.put(idempotencyKey, event.eventId);

      return true;
    });
  }

  async getEvents(
    id: string,
    scope: MemoryScope,
    options?: { limit?: number; afterSequence?: number },
  ): Promise<MemoryEvent[]> {
    const eventsKey = this.getEventsKey(id, scope);
    const events = (await this.ctx.storage.get<MemoryEvent[]>(eventsKey)) ?? [];

    let filtered = events;
    if (options?.afterSequence !== undefined) {
      filtered = events.slice(options.afterSequence);
    }
    if (options?.limit !== undefined) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered.map((e) => MemoryEventSchema.parse(e));
  }

  async getSnapshot(
    id: string,
    scope: MemoryScope,
  ): Promise<MemorySnapshot | undefined> {
    const snapshotKey = this.getSnapshotKey(id, scope);
    const snapshot = await this.ctx.storage.get<MemorySnapshot>(snapshotKey);
    return snapshot ? MemorySnapshotSchema.parse(snapshot) : undefined;
  }

  async updateSnapshot(snapshot: MemorySnapshot): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const validated = MemorySnapshotSchema.parse(snapshot);
      const id = snapshot.runId || snapshot.sessionId;
      const scope: MemoryScope = snapshot.runId ? "run" : "session";

      if (!id) {
        throw new Error("Snapshot must have either runId or sessionId");
      }

      const snapshotKey = this.getSnapshotKey(id, scope);
      await this.ctx.storage.put(snapshotKey, validated);
    });
  }

  async createCheckpoint(checkpoint: ReplayCheckpoint): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const validated = ReplayCheckpointSchema.parse(checkpoint);
      const checkpointKey = this.getCheckpointKey(
        checkpoint.runId,
        checkpoint.sequence,
      );
      await this.ctx.storage.put(checkpointKey, validated);
    });
  }

  async getCheckpoint(
    runId: string,
    sequence: number,
  ): Promise<ReplayCheckpoint | undefined> {
    const checkpointKey = this.getCheckpointKey(runId, sequence);
    const checkpoint =
      await this.ctx.storage.get<ReplayCheckpoint>(checkpointKey);
    return checkpoint ? ReplayCheckpointSchema.parse(checkpoint) : undefined;
  }

  async getLatestCheckpoint(
    runId: string,
  ): Promise<ReplayCheckpoint | undefined> {
    const prefix = `run:${runId}:memory:checkpoint:`;
    const checkpoints = await this.ctx.storage.list<ReplayCheckpoint>({
      prefix,
    });

    if (checkpoints.size === 0) {
      return undefined;
    }

    const sorted = Array.from(checkpoints.entries())
      .sort((a, b) => {
        const seqA = parseInt(a[0].split(":").pop() ?? "0", 10);
        const seqB = parseInt(b[0].split(":").pop() ?? "0", 10);
        return seqB - seqA;
      })
      .map(([, value]) => value as ReplayCheckpoint);

    return sorted[0] ? ReplayCheckpointSchema.parse(sorted[0]) : undefined;
  }

  async getAllCheckpoints(runId: string): Promise<ReplayCheckpoint[]> {
    const prefix = `run:${runId}:memory:checkpoint:`;
    const checkpoints = await this.ctx.storage.list<ReplayCheckpoint>({
      prefix,
    });

    return Array.from(checkpoints.values())
      .sort(
        (a, b) =>
          (a as ReplayCheckpoint).sequence - (b as ReplayCheckpoint).sequence,
      )
      .map((c) => ReplayCheckpointSchema.parse(c));
  }

  async clearRunMemory(runId: string): Promise<void> {
    const keysToDelete: string[] = [
      this.getEventsKey(runId, "run"),
      this.getSnapshotKey(runId, "run"),
    ];

    const idempotencyPrefix = `run:${runId}:memory:idempotency:`;
    const idempotencyKeys = await this.ctx.storage.list({
      prefix: idempotencyPrefix,
    });
    keysToDelete.push(...Array.from(idempotencyKeys.keys()));

    const checkpointPrefix = `run:${runId}:memory:checkpoint:`;
    const checkpointKeys = await this.ctx.storage.list({
      prefix: checkpointPrefix,
    });
    keysToDelete.push(...Array.from(checkpointKeys.keys()));

    if (keysToDelete.length > 0) {
      for (let i = 0; i < keysToDelete.length; i += 128) {
        const chunk = keysToDelete.slice(i, i + 128);
        await this.ctx.storage.delete(chunk);
      }
    }
  }
}
