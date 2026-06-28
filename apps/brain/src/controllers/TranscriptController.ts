import { z } from "zod";
import {
  CHAT_TITLE_SOURCES,
  isTurnActivityTranscriptPart,
  type JsonValue,
  type TurnActivityTranscriptPart,
} from "@repo/shared-types";
import { RunIdSchema } from "@repo/platform-protocol";
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
  runId: RunIdSchema.optional(),
  workspaceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  titleSource: z.enum(CHAT_TITLE_SOURCES).optional(),
  repository: z.string().trim().min(1).max(240).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
});

const TranscriptQuerySchema = z.object({
  session: z.string().uuid(),
  runId: RunIdSchema,
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const ArchiveSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

const RenameSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
  titleSource: z.enum(CHAT_TITLE_SOURCES).optional(),
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
      const session = await createPersistedSession(body, auth.userId, env);

      return jsonResponse(request, env, { session }, { status: 201 });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async renameSessionTitle(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { sessionId } = SessionParamsSchema.parse(
        readSessionParams(request.url),
      );
      const body = RenameSessionRequestSchema.parse(await request.json());
      const session = await withTranscriptRepository(env, (repository) => {
        if (body.titleSource === "generated") {
          return repository.updateGeneratedSessionTitle({
            userId: auth.userId,
            sessionId,
            title: body.title,
            titleSource: "generated",
          });
        }
        return repository.renameSessionTitle({
          userId: auth.userId,
          sessionId,
          title: body.title,
          titleSource: "user",
        });
      });

      if (!session) {
        return errorResponse(request, env, "Session not found", 404);
      }

      console.log(
        `[chat/title] updated sessionId=${sessionId} source=${body.titleSource ?? "user"} titleLength=${body.title.length}`,
      );
      return jsonResponse(request, env, { session });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async pinSession(request: Request, env: Env): Promise<Response> {
    return sessionMutationResponse(
      request,
      env,
      "pin",
      (repository, userId, sessionId) =>
        repository.pinSession(userId, sessionId),
    );
  }

  static async unpinSession(request: Request, env: Env): Promise<Response> {
    return sessionMutationResponse(
      request,
      env,
      "unpin",
      (repository, userId, sessionId) =>
        repository.unpinSession(userId, sessionId),
    );
  }

  static async archiveSession(request: Request, env: Env): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const { sessionId } = ArchiveSessionParamsSchema.parse(
        readSessionParams(request.url),
      );
      const session = await withTranscriptRepository(env, (repository) =>
        repository.archiveSession(auth.userId, sessionId),
      );

      if (!session) {
        return errorResponse(request, env, "Session not found", 404);
      }

      console.log(`[chat/archive] archived sessionId=${sessionId}`);
      return jsonResponse(request, env, { session });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async unarchiveSession(request: Request, env: Env): Promise<Response> {
    return sessionMutationResponse(
      request,
      env,
      "unarchive",
      (repository, userId, sessionId) =>
        repository.unarchiveSession(userId, sessionId),
    );
  }

  static async listArchivedSessions(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const sessions = await withTranscriptRepository(env, (repository) =>
        repository.listArchivedSessions(auth.userId),
      );
      return jsonResponse(request, env, { sessions });
    } catch (error) {
      return transcriptErrorResponse(request, env, error);
    }
  }

  static async getHistory(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const queryParams = new URL(request.url).searchParams;
    const requestedRunId = queryParams.get("runId")?.trim() ?? "";
    const requestedSessionId = queryParams.get("session")?.trim() ?? "";
    try {
      console.log(
        `[chat/history] requestId=${requestId} runId=${requestedRunId || "missing"} sessionId=${requestedSessionId || "missing"} status=started`,
      );
      const auth = await getAuthenticatedUserSession(request, env);
      if (!auth) {
        console.warn(
          `[chat/history] requestId=${requestId} runId=${requestedRunId || "missing"} sessionId=${requestedSessionId || "missing"} status=unauthorized elapsedMs=${Date.now() - startedAt}`,
        );
        return errorResponse(request, env, "Unauthorized", 401);
      }

      const query = TranscriptQuerySchema.parse(
        Object.fromEntries(queryParams),
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

      const response = {
        messages: result.messages.map(toHydrationMessage),
        nextCursor: result.nextCursor?.toString(),
      };
      console.log(
        `[chat/history] requestId=${requestId} runId=${query.runId} sessionId=${query.session} status=success messageCount=${response.messages.length} messageIds=${summarizeHydrationMessages(response.messages)} nextCursor=${response.nextCursor ?? "none"} elapsedMs=${Date.now() - startedAt}`,
      );
      return jsonResponse(request, env, response);
    } catch (error) {
      console.error(
        `[chat/history] requestId=${requestId} runId=${requestedRunId || "unknown"} sessionId=${requestedSessionId || "unknown"} status=failed elapsedMs=${Date.now() - startedAt}`,
        summarizeTranscriptError(error),
      );
      return transcriptErrorResponse(request, env, error);
    }
  }
}

function summarizeHydrationMessages(
  messages: Array<ReturnType<typeof toHydrationMessage>>,
): string {
  return messages
    .map((message) => `${message.role}:${message.id}`)
    .join(",");
}

async function createPersistedSession(
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
      titleSource: body.titleSource ?? "generated",
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

const SessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

type TranscriptRepositoryForMutation = Parameters<
  Parameters<typeof withTranscriptRepository>[1]
>[0];

async function sessionMutationResponse(
  request: Request,
  env: Env,
  operation: "pin" | "unpin" | "unarchive",
  mutate: (
    repository: TranscriptRepositoryForMutation,
    userId: string,
    sessionId: string,
  ) => Promise<SessionRecord | null>,
): Promise<Response> {
  try {
    const auth = await getAuthenticatedUserSession(request, env);
    if (!auth) {
      return errorResponse(request, env, "Unauthorized", 401);
    }

    const { sessionId } = SessionParamsSchema.parse(
      readSessionParams(request.url),
    );
    const session = await withTranscriptRepository(env, (repository) =>
      mutate(repository, auth.userId, sessionId),
    );

    if (!session) {
      return errorResponse(request, env, "Session not found", 404);
    }

    console.log(formatSessionMutationLog(operation, sessionId));
    return jsonResponse(request, env, { session });
  } catch (error) {
    return transcriptErrorResponse(request, env, error);
  }
}

function formatSessionMutationLog(
  operation: "pin" | "unpin" | "unarchive",
  sessionId: string,
): string {
  if (operation === "pin") {
    return `[chat/pin] pinned sessionId=${sessionId}`;
  }
  if (operation === "unpin") {
    return `[chat/pin] unpinned sessionId=${sessionId}`;
  }
  return `[chat/archive] unarchived sessionId=${sessionId}`;
}

function readSessionParams(url: string): { sessionId: string | null } {
  const match = new URL(url).pathname.match(/^\/api\/sessions\/([^/]+)\//);
  return { sessionId: match?.[1] ?? null };
}

function toHydrationMessage(message: TranscriptMessageRecord): {
  id: string;
  role: TranscriptMessageRecord["role"];
  content: string | Array<{ type: "text"; text: string } | JsonValue>;
  createdAt: string;
  data?: {
    activityParts?: TurnActivityTranscriptPart[];
    metadata?: Record<string, unknown>;
  };
} {
  const textContent = readSingleTextPart(message.parts);
  const data = readHydrationData(message.parts);
  const hydratedMessage = {
    id: message.clientMessageId ?? message.id,
    role: message.role,
    content: textContent ?? message.parts.map(partToHydrationContent),
    createdAt: message.createdAt,
  };
  return data ? { ...hydratedMessage, data } : hydratedMessage;
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

function readHydrationData(
  parts: TranscriptMessagePartRecord[],
):
  | {
      activityParts?: TurnActivityTranscriptPart[];
      metadata?: Record<string, unknown>;
    }
  | undefined {
  const activityParts: TurnActivityTranscriptPart[] = [];
  for (const part of parts) {
    if (part.type === "activity" && isTurnActivityTranscriptPart(part.content)) {
      activityParts.push(part.content);
    }
  }
  const metadata = parts
    .filter((part) => part.type === "text")
    .map((part) => readPartMetadata(part.content))
    .find((value): value is Record<string, unknown> => value !== null);
  if (activityParts.length === 0 && !metadata) {
    return undefined;
  }
  return {
    ...(activityParts.length > 0 ? { activityParts } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function readPartMetadata(value: JsonValue): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const metadata = value.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : null;
}

function transcriptErrorResponse(
  request: Request,
  env: Env,
  error: unknown,
): Response {
  if (error instanceof z.ZodError) {
    console.warn("[transcript/request] invalid request", error.issues);
    return errorResponse(request, env, "Invalid transcript request", 400);
  }

  if (isSessionStoreUnavailableError(error)) {
    return errorResponse(request, env, error.message, 503);
  }

  console.error("[transcript/persistence] request failed:", error);
  return errorResponse(request, env, "Failed to load transcript state", 500);
}

function summarizeTranscriptError(error: unknown): {
  name: string;
  message: string;
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}
