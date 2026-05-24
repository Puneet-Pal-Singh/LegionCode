import { z } from "zod";
import type { JsonValue } from "@repo/shared-types";
import type {
  SessionRecord,
  TranscriptMessagePartRecord,
  TranscriptMessageRecord,
} from "@repo/persistence";
import { errorResponse, jsonResponse } from "../http/response";
import type { Env } from "../types/ai";
import {
  getAuthenticatedUserSession,
  isSessionStoreUnavailableError,
} from "../services/AuthService";
import { withRunRepository } from "../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";

const SessionCreateRequestSchema = z.object({
  sessionId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  repository: z.string().trim().min(1).max(240).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
});

const TranscriptQuerySchema = z.object({
  session: z.string().uuid(),
  runId: z.string().uuid(),
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const ArchiveSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

export class TranscriptController {
  static async listSessions(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const payload = await withTranscriptRepository(env, (repository) =>
        repository.listSessions(auth.userId),
      );
      return jsonResponse(request, env, payload);
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async createSession(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const body = SessionCreateRequestSchema.parse(await request.json());
      if (body.runId) {
        await ensureSessionRun(body, body.runId, auth.userId, env);
      }

      const session = await withTranscriptRepository(env, (repository) =>
        repository.ensureSession({
          sessionId: body.sessionId,
          userId: auth.userId,
          workspaceId: body.workspaceId ?? null,
          title: body.title ?? "Untitled task",
          repository: body.repository ?? null,
          activeRunId: body.runId ?? null,
          mode: body.mode ?? "build",
          status: "idle",
        }),
      );

      return jsonResponse(request, env, { session }, { status: 201 });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async archiveSession(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { sessionId } = ArchiveSessionParamsSchema.parse(
        readArchiveSessionParams(request.url),
      );
      const archived = await withTranscriptRepository(env, (repository) =>
        repository.archiveSession(auth.userId, sessionId),
      );

      if (!archived) {
        return errorResponse(request, env, "Session not found", 404);
      }

      return jsonResponse(request, env, { archived: true });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async getHistory(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const query = TranscriptQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      const result = await withTranscriptRepository(env, (repository) =>
        repository.listTranscript({
          sessionId: query.session,
          userId: auth.userId,
          runId: query.runId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );

      return jsonResponse(request, env, {
        messages: result.messages.map(toHydrationMessage),
        nextCursor: result.nextCursor?.toString(),
      });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }
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

function readArchiveSessionParams(url: string): { sessionId: string | null } {
  const match = new URL(url).pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  return { sessionId: match?.[1] ?? null };
}

function toHydrationMessage(message: TranscriptMessageRecord): {
  id: string;
  role: TranscriptMessageRecord["role"];
  content: string | Array<{ type: "text"; text: string } | JsonValue>;
  createdAt: string;
} {
  const textContent = readSingleTextPart(message.parts);
  return {
    id: message.id,
    role: message.role,
    content: textContent ?? message.parts.map(partToHydrationContent),
    createdAt: message.createdAt,
  };
}

function readSingleTextPart(
  parts: TranscriptMessagePartRecord[],
): string | null {
  if (parts.length !== 1 || parts[0]?.type !== "text") {
    return null;
  }

  const content = parts[0].content;
  if (typeof content === "object" && content && !Array.isArray(content)) {
    const text = content.text;
    return typeof text === "string" ? text : null;
  }

  return typeof content === "string" ? content : null;
}

function partToHydrationContent(
  part: TranscriptMessagePartRecord,
): { type: "text"; text: string } | JsonValue {
  if (part.type !== "text") {
    return part.content;
  }

  const text = readSingleTextPart([part]);
  return { type: "text", text: text ?? "" };
}

function transcriptErrorResponse(
  request: Request,
  env: Env,
  error: unknown,
): Response {
  if (error instanceof z.ZodError) {
    return errorResponse(request, env, "Invalid transcript request", 400);
  }

  if (isSessionStoreUnavailableError(error)) {
    return errorResponse(request, env, error.message, 503);
  }

  console.error("[transcript/persistence] request failed:", error);
  return errorResponse(request, env, "Failed to load transcript state", 500);
}
