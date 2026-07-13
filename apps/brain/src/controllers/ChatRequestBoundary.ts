import type { Env } from "../types/ai";
import { DomainError } from "../domain/errors";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import { extractIdentifiers } from "./chat-request-helpers";
import {
  resolveExecutionScope,
  type ExecutionScope,
} from "./chat-runtime-helpers";
import {
  validateChatImageInput,
  type ChatImageInputState,
} from "../services/chat/ChatImageInputPolicy";
import {
  ChatRequestBodySchema,
  type ChatRequestBody,
} from "./chat-request-schema";
import { ChatProviderSelectionSchema } from "../schemas/provider";

export interface AuthenticatedChatRequest extends ExecutionScope {
  body: ChatRequestBody;
  correlationId: string;
  sessionId: string;
  runId: string;
  imageInput: ChatImageInputState;
  identity: NonNullable<ChatRequestBody["identity"]>;
}

/** Parses the public chat envelope and binds it to its authorized turn scope. */
export async function parseAuthenticatedChatRequest(
  req: Request,
  env: Env,
  correlationId: string,
): Promise<AuthenticatedChatRequest> {
  const body = validateWithSchema<ChatRequestBody>(
    await parseRequestBody(req, correlationId),
    ChatRequestBodySchema,
    correlationId,
  );
  const { sessionId, runId } = extractIdentifiers(body, correlationId);
  if (!body.identity) {
    throw new DomainError(
      "TURN_BOOTSTRAP_REQUIRED",
      "A server-issued turn bootstrap is required before chat execution.",
      428,
      false,
      correlationId,
    );
  }

  validateWithSchema(
    { providerId: body.providerId, modelId: body.modelId },
    ChatProviderSelectionSchema,
    correlationId,
  );
  const imageInput = validateChatImageInput(body, correlationId);
  const executionScope = await resolveExecutionScope(
    req,
    env,
    runId,
    correlationId,
  );
  if (body.identity.workspaceId !== executionScope.workspaceId) {
    throw new DomainError(
      "TURN_SCOPE_MISMATCH",
      "Turn bootstrap identity does not match the authorized workspace scope.",
      409,
      false,
      correlationId,
    );
  }

  return {
    body,
    correlationId,
    sessionId,
    runId,
    imageInput,
    ...executionScope,
    identity: body.identity,
  };
}
