import { AppServerOperationError } from "@legioncode/app-server/server";
import {
  ChatImageReadParamsSchema, ChatImageReadResultSchema, CHAT_IMAGE_CHUNK_MAX_BYTES,
  type ChatImageReadParams,
} from "@legioncode/app-server/protocol";
import { parseProviderAuthScopeRequest } from "../../controllers/provider/ProviderAuthScopeService";
import { isDomainError } from "../../domain/errors";
import { ownsChatMediaSession } from "../../services/chat/ChatMediaAuthorization";
import { ChatMediaStore } from "../../services/chat/ChatMediaStore";
import type { Env } from "../../types/ai";

/** Same owned-session originals as the Web image route, over the authenticated SDK boundary. */
export function composeHostedChatMediaReads(request: Request, env: Env, userId: string) {
  return {
    async readImage(input: Extract<ChatImageReadParams, { sessionId: string }>) {
      const params = ChatImageReadParamsSchema.parse(input);
      if (!("sessionId" in params)) throw new AppServerOperationError(400, "invalid_request", "Hosted image scope is required");
      if (params.offset >= params.reference.byteSize)
        throw new AppServerOperationError(400, "invalid_request", "Image byte range is invalid");
      if (!env.EDIT_ARTIFACTS)
        throw new AppServerOperationError(503, "server_unavailable", "Conversation images are unavailable", "CHAT_MEDIA_UNAVAILABLE", true);
      try {
        request.signal.throwIfAborted();
        const scope = parseProviderAuthScopeRequest(request, request.headers.get("X-Correlation-Id") ?? crypto.randomUUID());
        if (scope.requestedUserId && scope.requestedUserId !== userId) throw notFound();
        const authorized = () => ownsChatMediaSession(env, userId, params.sessionId, scope.requestedWorkspaceId);
        if (!(await authorized())) throw notFound();
        const bytes = await new ChatMediaStore(env.EDIT_ARTIFACTS).getOriginalImage({
          userId, sessionId: params.sessionId, ref: params.reference,
        });
        request.signal.throwIfAborted();
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
          .map((byte) => byte.toString(16).padStart(2, "0")).join("");
        if (!(await authorized())) throw notFound();
        request.signal.throwIfAborted();
        const end = Math.min(bytes.byteLength, params.offset + (params.limit ?? CHAT_IMAGE_CHUNK_MAX_BYTES));
        let binary = "";
        for (const byte of bytes.subarray(params.offset, end)) binary += String.fromCharCode(byte);
        return ChatImageReadResultSchema.parse({
          reference: params.reference, sha256, offset: params.offset, byteLength: end - params.offset,
          dataBase64: btoa(binary), nextOffset: end < bytes.byteLength ? end : null,
        });
      } catch (error) {
        if (error instanceof AppServerOperationError) throw error;
        if (isDomainError(error) && error.code === "CHAT_MEDIA_NOT_FOUND") throw notFound();
        throw new AppServerOperationError(503, "server_unavailable", "Conversation image could not be verified", "CHAT_MEDIA_UNAVAILABLE", true);
      }
    },
  };
}

function notFound(): AppServerOperationError {
  return new AppServerOperationError(404, "not_found", "Conversation image was not found", "CHAT_MEDIA_NOT_FOUND", false);
}
