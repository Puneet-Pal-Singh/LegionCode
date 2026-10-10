import { z } from "zod";
import { RunIdSchema } from "@repo/platform-protocol";
import type { SessionRecord } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";

export const SessionCreateRequestSchema = z.object({
  sessionId: z.string().uuid(),
  runId: RunIdSchema.optional(),
  workspaceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  repository: z.string().trim().min(1).max(240).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
});

export async function createPersistedSession(
  body: z.infer<typeof SessionCreateRequestSchema>,
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
  body: z.infer<typeof SessionCreateRequestSchema>,
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
  body: z.infer<typeof SessionCreateRequestSchema>,
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
