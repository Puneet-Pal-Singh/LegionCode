import type { CoreMessage } from "ai";
import type { JsonValue } from "@repo/shared-types";
import type { TranscriptRepository } from "@repo/persistence";
import { pruneToolResults } from "@shadowbox/context-pruner";
import { Env } from "../types/ai";
import { withTranscriptRepository } from "./sessions/TranscriptPersistenceFactory";

interface PersistMessageContext {
  userId?: string;
  workspaceId?: string;
  title?: string;
  repository?: string;
}

export class PersistenceService {
  constructor(private env: Env) {}

  private async generateIdempotencyKey(
    sessionId: string,
    runId: string,
    role: string,
    content: string,
  ): Promise<string> {
    const data = `${sessionId}:${runId}:${role}:${content}`;
    const msgUint8 = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async persistUserMessage(
    sessionId: string,
    runId: string,
    message: CoreMessage,
    context: PersistMessageContext = {},
  ): Promise<void> {
    try {
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);

      const idempotencyKey = await this.generateMessageIdempotencyKey(
        sessionId,
        runId,
        message,
        content,
      );

      await this.persistMessage({
        sessionId,
        runId,
        message,
        idempotencyKey,
        context,
      });
      console.log(`[Brain] Persisted ${message.role} message for run ${runId}`);
    } catch (e) {
      console.error("[Brain] Persist user message failed", e);
    }
  }

  async persistConversation(
    sessionId: string,
    runId: string,
    messages: CoreMessage[],
    correlationId: string,
  ): Promise<void> {
    console.log(
      `[Brain:${correlationId}] Persisting conversation. Total: ${messages.length} messages`,
    );
    const roles = messages.map((m) => m.role).join(" -> ");
    console.log(`[Brain:${correlationId}] Message Roles: ${roles}`);

    try {
      const prunedHistory = pruneToolResults(messages);
      console.log(
        `[Brain:${correlationId}] Pruned for context sync: ${prunedHistory.length} messages`,
      );

      if (prunedHistory.length > 0) {
        await this.persistPrunedHistory(sessionId, runId, prunedHistory);
        console.log(`[Brain:${correlationId}] History Sync Successful`);
      }
    } catch (e) {
      console.error(`[Brain:${correlationId}] History Sync Failed:`, e);
    }
  }

  private async persistPrunedHistory(
    sessionId: string,
    runId: string,
    messages: CoreMessage[],
  ): Promise<void> {
    await withTranscriptRepository(this.env, async (repository) => {
      await repository.transaction(async (txRepo) => {
        for (const message of messages) {
          const content =
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content);
          const idempotencyKey = await this.generateMessageIdempotencyKey(
            sessionId,
            runId,
            message,
            content,
          );
          await this.persistMessage(
            {
              sessionId,
              runId,
              message,
              idempotencyKey,
              context: {},
            },
            txRepo,
          );
        }
      });
    });
  }

  private async persistMessage(
    input: {
      sessionId: string;
      runId: string;
      message: CoreMessage;
      idempotencyKey: string;
      context: PersistMessageContext;
    },
    repository?: TranscriptRepository,
  ): Promise<void> {
    if (repository) {
      await this.doPersistMessage(input, repository);
      return;
    }

    await withTranscriptRepository(this.env, async (repo) => {
      await this.doPersistMessage(input, repo);
    });
  }

  private async doPersistMessage(
    input: {
      sessionId: string;
      runId: string;
      message: CoreMessage;
      idempotencyKey: string;
      context: PersistMessageContext;
    },
    repository: TranscriptRepository,
  ): Promise<void> {
    const parts = coreMessageToTranscriptParts(input.message);
    if (input.context.userId) {
      await repository.appendMessage({
        sessionId: input.sessionId,
        runId: input.runId,
        userId: input.context.userId,
        workspaceId: input.context.workspaceId ?? null,
        title: input.context.title ?? buildTitle(input.message),
        repository: input.context.repository ?? null,
        activeRunId: input.runId,
        status: "running",
        role: input.message.role,
        clientMessageId: readClientMessageId(input.message),
        dedupeKey: input.idempotencyKey,
        parts,
      });
      return;
    }

    await repository.appendMessageToExistingSession({
      sessionId: input.sessionId,
      runId: input.runId,
      role: input.message.role,
      clientMessageId: readClientMessageId(input.message),
      dedupeKey: input.idempotencyKey,
      parts,
    });
  }

  private async generateMessageIdempotencyKey(
    sessionId: string,
    runId: string,
    message: CoreMessage,
    content: string,
  ): Promise<string> {
    return await this.generateIdempotencyKey(
      sessionId,
      runId,
      readClientMessageId(message) ?? message.role,
      content,
    );
  }
}

function coreMessageToTranscriptParts(message: CoreMessage): Array<{
  type: "text" | "raw";
  content: JsonValue;
}> {
  if (typeof message.content === "string") {
    return [{ type: "text", content: { text: message.content } }];
  }

  return [{ type: "raw", content: toJsonValue(message.content) }];
}

function buildTitle(message: CoreMessage): string {
  const content =
    typeof message.content === "string"
      ? message.content.trim()
      : JSON.stringify(message.content);
  const title = content.replace(/\s+/g, " ").slice(0, 80).trim();
  return title || "Untitled task";
}

function readClientMessageId(message: CoreMessage): string | null {
  const candidate = message as { id?: unknown };
  return typeof candidate.id === "string" ? candidate.id : null;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
