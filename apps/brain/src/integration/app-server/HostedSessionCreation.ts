import { HostedSessionCreateRequestSchema, type HostedSessionCreateRequest } from "@repo/platform-protocol";
import type { SessionRecord } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";

export const SessionCreateRequestSchema = HostedSessionCreateRequestSchema.strip();

export async function createPersistedSession(
  body: HostedSessionCreateRequest,
  userId: string,
  env: Env,
): Promise<SessionRecord> {
  const session = await ensureTranscriptSession(body, userId, env, null);
  if (!body.runId) {
    return session;
  }

  await ensureSessionRun(body, body.runId, userId, env);
  return await ensureTranscriptSession(body, userId, env, body.runId);
}

async function ensureTranscriptSession(
  body: HostedSessionCreateRequest,
  userId: string,
  env: Env,
  activeRunId: string | null,
): Promise<SessionRecord> {
  return await withTranscriptRepository(env, (repository) =>
    repository.ensureSession({
      sessionId: body.sessionId,
      userId,
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
  userId: string,
  env: Env,
): Promise<void> {
  await withRunRepository(env, async (repository) => {
    await repository.ensureRun({
      id: runId,
      userId,
      workspaceId: body.workspaceId ?? null,
      sessionId: body.sessionId,
      taskId: body.sessionId,
      status: "created",
      mode: body.mode ?? "build",
    });
  });
}
