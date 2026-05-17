/**
 * SessionMemoryFactory - Build session memory client.
 *
 * Single Responsibility: Create and configure session memory client for runtime.
 * Uses Brain persistence repositories so durable memory is Postgres-backed.
 */

import type { Env } from "../../types/ai";
import { SessionMemoryClient } from "../../services/memory/SessionMemoryClient";

/**
 * Build session memory client for canonical session memory events.
 *
 * @param env - Cloudflare environment
 * @param userId - User ID that owns the session memory rows
 * @param sessionId - Session ID for client initialization
 * @returns SessionMemoryClient
 */
export function buildSessionMemoryClient(
  env: Env,
  userId: string,
  sessionId: string,
): SessionMemoryClient {
  return new SessionMemoryClient({
    env,
    userId,
    sessionId,
  });
}
