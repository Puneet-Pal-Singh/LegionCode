import { createThreadId, type HostedSessionCreateRequest } from "@repo/platform-protocol";
import type { SessionRecord } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";

export async function createPersistedSession(
  body: HostedSessionCreateRequest,
  userId: string,
  env: Env,
): Promise<SessionRecord> {
  // The repository applies this server-issued candidate only on INSERT. A
  // concurrent creator/retry receives the persisted winner; legacy nulls stay null.
  const session = await ensureTranscriptSession(body, userId, env, null, createThreadId());
  if (!body.runId) {
    return session;
  }

  await ensureSessionRun(body, body.runId, session, env);
  return await ensureTranscriptSession(body, userId, env, body.runId, session.threadId ?? undefined);
}

async function ensureTranscriptSession(
  body: HostedSessionCreateRequest,
  userId: string,
  env: Env,
  activeRunId: string | null,
  initialThreadId?: string,
): Promise<SessionRecord> {
  return await withTranscriptRepository(env, (repository) =>
    repository.ensureSession({
      sessionId: body.sessionId,
      userId,
      initialThreadId,
      workspaceId: body.workspaceId ?? null,
      title: body.title ?? "Untitled task",
      titleSource: "preview",
      repository: body.repository ?? null,
      activeRunId,
      mode: body.mode ?? "build",
      status: "idle",
    }),
  );
}

async function ensureSessionRun(
  body: HostedSessionCreateRequest,
  runId: string,
  session: SessionRecord,
  env: Env,
): Promise<void> {
  await withRunRepository(env, async (repository) => {
    await repository.ensureRun({
      id: runId,
      // Run metadata resolves Thread identity through this persisted session,
      // never through the losing creation candidate or a client-supplied ID.
      userId: session.userId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      taskId: session.taskId,
      status: "created",
      mode: body.mode ?? "build",
    });
  });
}
