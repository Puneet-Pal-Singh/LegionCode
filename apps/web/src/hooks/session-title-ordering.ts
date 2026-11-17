import type { AgentSession } from "../types/session.js";
import { shouldRetainCurrentTitleProjection } from "@legioncode/client-ui";

/**
 * Resolves a stale replay/hydration race without making title state browser
 * owned. A user-authored title is authoritative over any automated title; for
 * automated titles, the server-issued version is authoritative.
 */
export function mergeServerSessionProjection(
  current: AgentSession,
  incoming: AgentSession,
): AgentSession {
  if (current.id !== incoming.id) {
    throw new Error("Cannot merge session projections with different ids");
  }

  if (shouldRetainCurrentTitleProjection(current, incoming)) {
    return {
      ...incoming,
      name: current.name,
      titleSource: current.titleSource,
      titleVersion: current.titleVersion ?? incoming.titleVersion,
      titleStatus: current.titleStatus ?? incoming.titleStatus,
    };
  }

  return incoming;
}
