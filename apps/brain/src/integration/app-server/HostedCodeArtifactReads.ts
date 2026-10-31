import { AppServerOperationError, type AppServerComposition } from "@legioncode/app-server/server";
import { InvalidTranscriptSnapshotError, type TranscriptMessageRecord } from "@repo/persistence";
import type { CodeArtifactContentRequest } from "@repo/platform-protocol";
import type { JsonValue } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import {
  readSecureCodeArtifactContent,
  SecureCodeArtifactContentNotFoundError,
} from "../../services/edit-artifacts/SecureCodeArtifactContentClient";

type HostedCodeArtifactReadsService = NonNullable<AppServerComposition["hostedCodeArtifactReadsService"]>;

const TRANSCRIPT_PAGE_LIMIT = 100;

/** Authenticated reads require an exact persisted call and its trusted import receipt. */
export function composeHostedCodeArtifactReads(
  env: Env,
  userId: string,
): HostedCodeArtifactReadsService {
  return {
    async codeContent(params: CodeArtifactContentRequest) {
      try {
        const ownedReference = await hasOwnedCodeArtifactReference(env, userId, params);
        if (!ownedReference) {
          throw new AppServerOperationError(404, "not_found", "Code artifact reference not found");
        }

        try {
          return { content: await readSecureCodeArtifactContent(env, params.key) };
        } catch (error) {
          if (error instanceof SecureCodeArtifactContentNotFoundError) {
            throw new AppServerOperationError(404, "not_found", "Code artifact content not found");
          }
          throw new AppServerOperationError(503, "server_unavailable", "Code artifact storage is unavailable", "API_ERROR", true);
        }
      } catch (error) {
        if (error instanceof AppServerOperationError) throw error;
        if (error instanceof InvalidTranscriptSnapshotError) {
          throw new AppServerOperationError(400, "invalid_request", error.message);
        }
        throw new AppServerOperationError(503, "server_unavailable", "Code artifact authorization is unavailable", "API_ERROR", true);
      }
    },
  };
}

async function hasOwnedCodeArtifactReference(
  env: Env,
  userId: string,
  request: CodeArtifactContentRequest,
): Promise<boolean> {
  return await withTranscriptRepository(env, async (repository) => {
    let page = await repository.listTranscript({
      sessionId: request.sessionId,
      userId,
      limit: TRANSCRIPT_PAGE_LIMIT,
    });
    if (!page.sessionFound) return false;
    const snapshot = page.snapshot;

    while (true) {
      for (const message of page.messages) {
        const references = findReferences(message, request.key);
        for (const reference of references) {
          if (
            await repository.hasLegacyHistoryArtifactReference?.({
              sessionId: request.sessionId,
              userId,
              messageId: message.id,
              partId: reference.partId,
              toolCallId: reference.toolCallId,
            })
          ) {
            return true;
          }
        }
      }
      if (page.nextCursor === null) return false;
      page = await repository.listTranscript({
        sessionId: request.sessionId,
        userId,
        cursor: page.nextCursor,
        snapshot,
        limit: TRANSCRIPT_PAGE_LIMIT,
      });
      if (!page.sessionFound) return false;
    }
  });
}

function findReferences(
  message: TranscriptMessageRecord,
  key: string,
): Array<{ partId: string; toolCallId: string }> {
  if (message.role !== "assistant") return [];
  const references: Array<{ partId: string; toolCallId: string }> = [];
  for (const part of message.parts) {
    const candidates = part.type === "tool_call"
      ? [part.content]
      : part.type === "raw" && isArray(part.content)
        ? part.content
        : [];
    for (const candidate of candidates) {
      const reference = readCodeArtifactReference(candidate, key);
      if (reference) references.push({ partId: part.id, toolCallId: reference.toolCallId });
    }
  }
  return references;
}

function readCodeArtifactReference(
  value: JsonValue,
  key: string,
): { toolCallId: string } | null {
  if (!isRecord(value)) return null;
  const args = value.args;
  const toolName = value.toolName;
  if (value.type === "tool-call" && toolName === "create_code_artifact" && isRecord(args)) {
    const toolCallId = readString(value, "toolCallId");
    return toolCallId && isExactR2Reference(args.content, key) ? { toolCallId } : null;
  }
  if (
    value.type === "tool_use" &&
    value.name === "create_code_artifact"
  ) {
    const toolCallId = readString(value, "id") ?? readString(value, "toolCallId");
    const input = readFunctionArguments(value.input);
    return toolCallId && isRecord(input) && isExactR2Reference(input.content, key)
      ? { toolCallId }
      : null;
  }

  // Imported historical provider records retain their original function-call shape.
  const functionCall = value.function;
  if (
    value.type === "function_call" &&
    value.name === "create_code_artifact"
  ) {
    const toolCallId = readString(value, "call_id") ?? readString(value, "toolCallId") ?? readString(value, "id");
    const args = readFunctionArguments(value.arguments);
    return toolCallId && isRecord(args) && isExactR2Reference(args.content, key)
      ? { toolCallId }
      : null;
  }
  if (!isRecord(functionCall) || functionCall.name !== "create_code_artifact") {
    return null;
  }
  const toolCallId = readString(value, "toolCallId") ?? readString(value, "call_id") ?? readString(value, "id");
  const parsedArguments = readFunctionArguments(functionCall.arguments);
  return toolCallId && isRecord(parsedArguments) && isExactR2Reference(parsedArguments.content, key)
    ? { toolCallId }
    : null;
}

function readFunctionArguments(value: JsonValue | undefined): JsonValue | null {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function isExactR2Reference(value: JsonValue | null | undefined, key: string): boolean {
  return isRecord(value) && value.type === "r2_ref" && value.key === key;
}

function readString(value: Record<string, JsonValue>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function isArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

function isRecord(value: JsonValue | null | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
