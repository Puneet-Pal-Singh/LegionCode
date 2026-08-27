import { z } from "zod";
import { errorResponse } from "../http/response";
import type { Env } from "../types/ai";
import { getAuthenticatedUserSession } from "../services/AuthService";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";
import {
  ChatMediaStore,
  isValidChatMediaAttachmentId,
} from "../services/chat/ChatMediaStore";

const MediaQuerySchema = z.object({
  session: z.string().uuid(),
});

/** Serves durable chat images only after authenticating and checking session ownership. */
export class ChatMediaController {
  static async get(request: Request, env: Env): Promise<Response> {
    const auth = await getAuthenticatedUserSession(request, env, {
      warnOnMissingCookie: false,
    });
    if (!auth) return errorResponse(request, env, "Unauthorized", 401);
    if (!env.EDIT_ARTIFACTS) {
      return errorResponse(request, env, "Chat media is unavailable", 503);
    }

    const url = new URL(request.url);
    const attachmentId = decodePathAttachmentId(url.pathname);
    if (!attachmentId || !isValidChatMediaAttachmentId(attachmentId)) {
      return errorResponse(request, env, "Attachment not found", 404);
    }

    const parsedQuery = MediaQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsedQuery.success) {
      return errorResponse(request, env, "Attachment not found", 404);
    }
    const sessionId = parsedQuery.data.session;
    if (!(await ownsSession(env, auth.userId, sessionId))) {
      return errorResponse(request, env, "Attachment not found", 404);
    }

    const media = await new ChatMediaStore(env.EDIT_ARTIFACTS).getImage({
      userId: auth.userId,
      sessionId,
      attachmentId,
    });
    if (!media) return errorResponse(request, env, "Attachment not found", 404);

    return new Response(media.body as unknown as BodyInit, {
      headers: {
        "Content-Type": media.mediaType,
        "Content-Length": String(media.byteSize),
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        Vary: "Cookie",
      },
    });
  }
}

function decodePathAttachmentId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/chat\/media\/([^/]+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function ownsSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  return await withTranscriptRepository(env, async (repository) => {
    const active = await repository.listSessions(userId);
    if (active.sessions.some((session) => session.id === sessionId)) return true;
    const archived = await repository.listArchivedSessions(userId);
    return archived.some((session) => session.id === sessionId);
  });
}
