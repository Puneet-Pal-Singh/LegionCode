import type { AgentSession } from "../types/session";

export type SessionPersistenceStatus = NonNullable<AgentSession["persistenceStatus"]>;

/** Existing hydrated sessions are persisted; only pending or failed drafts block writes. */
export function isSessionPersistenceReady(
  status: SessionPersistenceStatus | undefined,
): boolean {
  return status === undefined || status === "saved";
}
