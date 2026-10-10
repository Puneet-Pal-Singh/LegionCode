import { RunModeSchema } from "@repo/shared-types";
import { AppServerClientError, type HostedSession } from "@legioncode/sdk";
import type { AgentSession, SessionStatus } from "../../types/session";
import { isCanonicalRunId } from "../../lib/run-id";
import { createHostedAppServerClient } from "./appServerClient";

// Retain the lifetime and response-body contract of the replaced hosted fetches.
function client() {
  return createHostedAppServerClient({ timeoutMs: null, maxResponseBytes: null });
}

export async function hydrateSessionsFromServer(): Promise<Record<string, AgentSession>> {
  const sessions = await client().listSessions();
  return Object.fromEntries(sessions.map(mapServerSession)
    .filter((session): session is AgentSession => session !== null)
    .map((session) => [session.id, session]));
}

export async function persistSession(session: AgentSession): Promise<AgentSession> {
  return mapped(await client().createSession({
    sessionId: session.id, title: session.name, mode: session.mode,
    ...(session.activeRunId !== null ? { runId: session.activeRunId } : {}),
    ...(session.repository !== null ? { repository: session.repository } : {}),
  }));
}

export async function renameSessionTitle(sessionId: string, title: string): Promise<AgentSession> {
  return mapped(await client().renameSession(sessionId, title));
}
export async function pinSession(sessionId: string): Promise<AgentSession> {
  return mapped(await client().pinSession(sessionId));
}
export async function unpinSession(sessionId: string): Promise<AgentSession> {
  return mapped(await client().unpinSession(sessionId));
}
export async function archiveSession(sessionId: string): Promise<AgentSession> {
  try { return mapped(await client().archiveSession(sessionId)); }
  catch (error) {
    // Preserve the existing local-only archive retirement classification.
    if (error instanceof AppServerClientError && error.serverCode === "not_found") {
      throw new Error("Session archive failed: 404");
    }
    throw error;
  }
}
export async function unarchiveSession(sessionId: string): Promise<AgentSession> {
  return mapped(await client().unarchiveSession(sessionId));
}
export async function deleteArchivedSession(sessionId: string): Promise<void> {
  await client().deleteArchivedSession(sessionId);
}
export async function hydrateArchivedSessionsFromServer(): Promise<AgentSession[]> {
  return (await client().listArchivedSessions()).map(mapServerSession)
    .filter((session): session is AgentSession => session !== null);
}

function mapped(session: ServerSessionRecord): AgentSession {
  const result = mapServerSession(session);
  if (!result) throw new Error("Invalid session response");
  return result;
}

export type ServerSessionRecord = HostedSession;

export function mapServerSession(session: ServerSessionRecord): AgentSession | null {
  const activeRunId = isCanonicalRunId(session.activeRunId)
    ? session.activeRunId
    : null;

  return {
    id: session.id,
    name: session.title,
    titleSource: session.titleSource ?? "preview",
    ...mapServerThreadMetadata(session),
    persistenceStatus: "saved",
    repository: session.repository,
    activeRunId,
    runIds: activeRunId ? [activeRunId] : [],
    status: mapServerStatus(session.status),
    mode: RunModeSchema.parse(session.mode),
    pinnedAt: session.pinnedAt ?? null,
    archivedAt: session.archivedAt ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function mapServerStatus(status: ServerSessionRecord["status"]): SessionStatus {
  return status;
}

function mapServerThreadMetadata(
  session: ServerSessionRecord,
): Pick<
  AgentSession,
  | "titleVersion"
  | "titleStatus"
  | "lastTerminalTurnId"
  | "lastAcknowledgedTerminalTurnId"
> {
  return {
    ...(isTitleVersion(session.titleVersion)
      ? { titleVersion: session.titleVersion }
      : {}),
    ...(isTitleStatus(session.titleStatus)
      ? { titleStatus: session.titleStatus }
      : {}),
    ...(typeof session.lastTerminalTurnId === "string"
      ? { lastTerminalTurnId: session.lastTerminalTurnId }
      : {}),
    ...(typeof session.lastAcknowledgedTerminalTurnId === "string"
      ? {
          lastAcknowledgedTerminalTurnId:
            session.lastAcknowledgedTerminalTurnId,
        }
      : {}),
  };
}

function isTitleVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTitleStatus(
  value: unknown,
): value is NonNullable<AgentSession["titleStatus"]> {
  return value === "pending" || value === "ready" || value === "failed";
}
