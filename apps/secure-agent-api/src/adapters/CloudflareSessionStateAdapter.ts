/**
 * CloudflareSessionStateAdapter - Implements SessionStatePort using Durable Objects.
 *
 * Adapts Cloudflare Durable Object storage to the canonical SessionStatePort interface.
 * Encapsulates session lifecycle, snapshots, and recovery.
 *
 * Canonical alignment: RunStorePort (Charter 46)
 */

import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  SessionStatePort,
  SessionState,
  SessionSnapshot,
} from "../ports/SessionStatePort";

/**
 * Storage key prefixes for session data.
 */
const SESSION_STATE_KEY_PREFIX = "session:state:";
const SESSION_SNAPSHOT_KEY_PREFIX = "session:snapshot:";
const SNAPSHOT_METADATA_KEY = "snapshot:metadata:";

// RECONSTRUCTABILITY: This adapter keeps live session coordination and
// short-lived execution snapshots in DO storage. Canonical transcript, run, and
// artifact metadata must be reconstructable from Postgres/R2.

/**
 * Snapshot metadata for tracking checkpoint progression.
 */
interface SnapshotMetadata {
  sessionId: string;
  checkpoint: number;
  savedAt: number;
  expiresAt?: number;
}

export class CloudflareSessionStateAdapter implements SessionStatePort {
  constructor(private durableObjectState: DurableObjectState) {}

  /**
   * Create a new session with initial state.
   * Stores session in Durable Object state.
   */
  async createSession(
    sessionId: string,
    runId: string,
    initialState?: Partial<SessionState>,
  ): Promise<SessionState> {
    const now = Date.now();
    const session: SessionState = {
      sessionId,
      status: initialState?.status ?? "active",
      createdAt: initialState?.createdAt ?? now,
      updatedAt: now,
      runId,
      metadata: initialState?.metadata,
    };

    const key = `${SESSION_STATE_KEY_PREFIX}${sessionId}`;
    await this.durableObjectState.storage.put(key, JSON.stringify(session));

    return session;
  }

  /**
   * Retrieve current session state.
   * Returns null if session not found.
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    const key = `${SESSION_STATE_KEY_PREFIX}${sessionId}`;
    const stored = await this.durableObjectState.storage.get(key);

    if (!stored) {
      return null;
    }

    try {
      return JSON.parse(stored as string) as SessionState;
    } catch {
      console.error(`[SessionStateAdapter] Failed to parse session: ${sessionId}`);
      return null;
    }
  }

  /**
   * Update session state with partial updates.
   * Maintains immutability by creating new state object.
   */
  async updateSession(
    sessionId: string,
    updates: Partial<SessionState>,
  ): Promise<void> {
    const current = await this.getSession(sessionId);
    if (!current) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const updated: SessionState = {
      ...current,
      ...updates,
      sessionId, // Immutable
      createdAt: current.createdAt, // Immutable
      updatedAt: Date.now(), // Always update timestamp
    };

    const key = `${SESSION_STATE_KEY_PREFIX}${sessionId}`;
    await this.durableObjectState.storage.put(key, JSON.stringify(updated));
  }

  /**
   * Save a session snapshot for recovery.
   * Includes messages, tool calls, and state at specific checkpoint.
   */
  async saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
    // Store the snapshot itself
    const snapshotKey = `${SESSION_SNAPSHOT_KEY_PREFIX}${snapshot.sessionId}`;
    await this.durableObjectState.storage.put(
      snapshotKey,
      JSON.stringify(snapshot),
    );

    // Store metadata for tracking checkpoints
    const metadataKey = `${SNAPSHOT_METADATA_KEY}${snapshot.sessionId}`;
    const metadata: SnapshotMetadata = {
      sessionId: snapshot.sessionId,
      checkpoint: snapshot.checkpoint,
      savedAt: Date.now(),
    };

    await this.durableObjectState.storage.put(
      metadataKey,
      JSON.stringify(metadata),
    );
  }

  /**
   * Restore session from last saved snapshot.
   * Returns null if no snapshot exists.
   */
  async loadSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const key = `${SESSION_SNAPSHOT_KEY_PREFIX}${sessionId}`;
    const stored = await this.durableObjectState.storage.get(key);

    if (!stored) {
      return null;
    }

    try {
      return JSON.parse(stored as string) as SessionSnapshot;
    } catch {
      console.error(
        `[SessionStateAdapter] Failed to parse snapshot: ${sessionId}`,
      );
      return null;
    }
  }

  /**
   * Delete session and all associated data.
   * Cleanup includes state, snapshots, and metadata.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const keys = [
      `${SESSION_STATE_KEY_PREFIX}${sessionId}`,
      `${SESSION_SNAPSHOT_KEY_PREFIX}${sessionId}`,
      `${SNAPSHOT_METADATA_KEY}${sessionId}`,
    ];

    await this.durableObjectState.storage.delete(keys);
  }
}
