import type { CoreMessage } from "ai";
import type { ChatImageAttachmentRef, JsonValue } from "@repo/shared-types";
import type { TurnScopeBootstrap } from "@repo/platform-protocol";
import type {
  AppendRunEventInput,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunStatus,
  TranscriptRepository,
  TranscriptMessageRecord,
  UpsertRunStepInput,
} from "@repo/persistence";
import { pruneToolResults } from "@legioncode/context-pruner";
import { Env } from "../types/ai";
import { DomainError, ValidationError } from "../domain/errors";
import { withTranscriptRepository } from "./sessions/TranscriptPersistenceFactory";
import { withRunRepository } from "./runs/RunPersistenceFactory";
import {
  buildRedactedMessageText,
  extractImageParts,
  messageHasImageParts,
} from "./chat/ImageMessageRedactor";
import { ChatMediaStore } from "./chat/ChatMediaStore";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";

import { PostgresTurnAdmissionRepository } from "@repo/persistence";
import { withBrainPersistenceRepository } from "./persistence/BrainPersistenceRepositoryFactory";

interface PersistMessageContext {
  userId?: string;
  workspaceId?: string;
  title?: string;
  repository?: string;
  identity?: TurnScopeBootstrap;
}

type TranscriptPersistenceOperation =
  | "persistUserMessage"
  | "persistConversation";

export class TranscriptPersistenceError extends DomainError {
  constructor(
    operation: TranscriptPersistenceOperation,
    _cause: unknown,
    correlationId?: string,
  ) {
    super(
      "TRANSCRIPT_PERSISTENCE_FAILED",
      "Transcript persistence failed",
      503,
      true,
      correlationId,
      {
        operation,
      },
    );
  }
}

export interface EnsureRunInput {
  id: string;
  userId: string;
  workspaceId?: string | null;
  sessionId: string;
  taskId: string;
  status?: RunStatus;
  mode?: string;
  providerId?: string | null;
  modelId?: string | null;
  branch?: string | null;
  baseCommitSha?: string | null;
  headCommitSha?: string | null;
}

export class PersistenceService {
  constructor(private env: Env) {}

  async ensureTranscriptSession(input: {
    sessionId: string;
    userId: string;
    workspaceId?: string | null;
    threadId?: string | null;
    taskId?: string | null;
    title?: string | null;
    repository?: string | null;
  }): Promise<void> {
    await withTranscriptRepository(this.env, async (repository) => {
      await repository.ensureSession({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        taskId: input.taskId ?? input.sessionId,
        title: input.title,
        repository: input.repository,
        status: "idle",
      });
    });
  }

  async ensureRun(input: EnsureRunInput): Promise<RunRecord> {
    return await withRunRepository(this.env, async (repository) => {
      return await repository.ensureRun(input);
    });
  }

  async appendRunEvent(input: {
    runId: string;
    sessionId: string;
    eventType: string;
    payload: JsonValue;
    idempotencyKey?: string | null;
  }): Promise<RunEventRecord> {
    return await withRunRepository(this.env, async (repository) => {
      return await repository.appendEvent(input);
    });
  }

  async writeRunProjection(input: {
    event: AppendRunEventInput;
    step?: UpsertRunStepInput;
  }): Promise<RunEventRecord> {
    return await withRunRepository(this.env, async (repository) =>
      repository.transaction(async (txRepository) => {
        const event = await txRepository.appendEvent(input.event);
        if (input.step) {
          await txRepository.upsertStep(resolveRunStepIndex(input.step, event));
        }
        return event;
      }),
    );
  }

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
  ): Promise<TranscriptMessageRecord> {
    try {
      console.log(
        formatDiagnosticLogLine("chat/persistence", "user-message-entered", {
          runId,
          sessionId,
          role: message.role,
          messageId: readClientMessageId(message),
          hasImages: messageHasImageParts(message),
          repository: context.repository ?? null,
          workspaceId: context.workspaceId ?? null,
        }),
      );
      const content = buildPersistenceDedupeContent(message);
      const idempotencyKey = await this.generateMessageIdempotencyKey(
        sessionId,
        runId,
        message,
        content,
      );
      const imageRefs = await this.persistImageAttachments({
        sessionId,
        userId: context.userId,
        message,
        idempotencyKey,
      });

      const persistedMessage = await this.persistMessage({
        sessionId,
        runId,
        message,
        idempotencyKey,
        context,
        imageRefs,
      });
      console.log(
        formatDiagnosticLogLine("chat/persistence", "user-message-persisted", {
          runId,
          sessionId,
          role: message.role,
          inputMessageId: readClientMessageId(message),
          persistedMessageId: persistedMessage.id,
          dedupeKey: idempotencyKey,
        }),
      );
      return persistedMessage;
    } catch (error) {
      console.error(
        formatDiagnosticLogLine("chat/persistence", "user-message-failed", {
          runId,
          sessionId,
          role: message.role,
          messageId: readClientMessageId(message),
          error,
        }),
      );
      throw new TranscriptPersistenceError("persistUserMessage", error);
    }
  }

  async admitUserTurn(input: {
    sessionId: string;
    runId: string;
    userId: string;
    workspaceId: string;
    taskId: string;
    identity: TurnScopeBootstrap;
    message: CoreMessage;
    mode: string;
    providerId?: string | null;
    modelId?: string | null;
    branch?: string | null;
  }): Promise<{ id: string; run: RunRecord }> {
    const clientMessageId = readClientMessageId(input.message);
    if (!clientMessageId) {
      throw new ValidationError(
        "A stable client message id is required before turn admission.",
        "CLIENT_MESSAGE_ID_REQUIRED",
      );
    }
    const content = buildPersistenceDedupeContent(input.message);
    const dedupeKey = await this.generateMessageIdempotencyKey(
      input.sessionId,
      input.runId,
      input.message,
      content,
    );
    const imageRefs = await this.persistImageAttachments({
      sessionId: input.sessionId,
      userId: input.userId,
      message: input.message,
      idempotencyKey: dedupeKey,
    });
    const requestFingerprint = await this.generateIdempotencyKey(
      input.sessionId,
      input.identity.turnId,
      `${clientMessageId}:${input.identity.revisionOfTurnId ?? "root"}:${input.mode}:${input.providerId ?? ""}:${input.modelId ?? ""}:${input.branch ?? ""}`,
      `${content}:${JSON.stringify(input.message)}`,
    );

    return await withBrainPersistenceRepository(
      this.env,
      this.env.AUTH_TURN_ADMISSION_REPOSITORY,
      (client) => new PostgresTurnAdmissionRepository(client),
      async (repository) => {
        const result = await repository.admitWithPrompt({
          sessionId: input.sessionId,
          clientMessageId,
          turnId: input.identity.turnId,
          runAttemptId: input.identity.runAttemptId,
          runId: input.runId,
          requestFingerprint,
          userId: input.userId,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          mode: input.mode,
          providerId: input.providerId,
          modelId: input.modelId,
          branch: input.branch,
          runStatus: "running",
          promptMessage: {
            role: "user",
            clientMessageId,
            dedupeKey,
            parts: coreMessageToTranscriptParts(
              input.message,
              input.identity,
              imageRefs,
            ),
          },
        });
        return { id: result.promptMessageId, run: result.run };
      },
    );
  }

  async findFirstPersistedUserMessage(input: {
    sessionId: string;
    userId: string;
  }): Promise<TranscriptMessageRecord | null> {
    let cursor: number | null = 0;

    while (cursor !== null) {
      const page = await withTranscriptRepository(this.env, (repository) =>
        repository.listTranscript({
          sessionId: input.sessionId,
          userId: input.userId,
          cursor,
          limit: 100,
        }),
      );
      const firstUserMessage = page.messages.find(
        (message) => message.role === "user",
      );
      if (firstUserMessage) {
        return firstUserMessage;
      }
      cursor = page.nextCursor;
    }

    return null;
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

      const latestMessage = prunedHistory.at(-1);
      if (latestMessage) {
        await this.persistLatestConversationMessage(
          sessionId,
          runId,
          latestMessage,
        );
        console.log(`[Brain:${correlationId}] History Sync Successful`);
      }
    } catch (error) {
      console.error(`[Brain:${correlationId}] History Sync Failed:`, error);
      throw new TranscriptPersistenceError(
        "persistConversation",
        error,
        correlationId,
      );
    }
  }

  private async persistLatestConversationMessage(
    sessionId: string,
    runId: string,
    message: CoreMessage,
  ): Promise<void> {
    await withTranscriptRepository(this.env, async (repository) => {
      await repository.transaction(async (txRepo) => {
        const content = buildPersistenceDedupeContent(message);
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
      imageRefs?: ChatImageAttachmentRef[];
    },
    repository?: TranscriptRepository,
  ): Promise<TranscriptMessageRecord> {
    if (repository) {
      return await this.doPersistMessage(input, repository);
    }

    return await withTranscriptRepository(this.env, async (repo) =>
      this.doPersistMessage(input, repo),
    );
  }

  private async doPersistMessage(
    input: {
      sessionId: string;
      runId: string;
      message: CoreMessage;
      idempotencyKey: string;
      context: PersistMessageContext;
      imageRefs?: ChatImageAttachmentRef[];
    },
    repository: TranscriptRepository,
  ): Promise<TranscriptMessageRecord> {
    const parts = coreMessageToTranscriptParts(
      input.message,
      input.context.identity,
      input.imageRefs,
    );
    const clientMessageId = readClientMessageId(input.message);
    console.log(
      `[chat/persistence] sessionId=${input.sessionId} runId=${input.runId} role=${input.message.role} clientMessageId=${clientMessageId ?? "missing"} dedupeKey=${input.idempotencyKey} status=append-started`,
    );
    if (input.context.userId) {
      const record = await repository.appendMessage({
        sessionId: input.sessionId,
        runId: input.runId,
        userId: input.context.userId,
        workspaceId: input.context.workspaceId,
        title: input.context.title,
        repository: input.context.repository,
        activeRunId: input.runId,
        status: "running",
        role: input.message.role,
        clientMessageId,
        dedupeKey: input.idempotencyKey,
        parts,
      });
      console.log(
        `[chat/persistence] sessionId=${input.sessionId} runId=${input.runId} messageId=${record.id} role=${record.role} clientMessageId=${record.clientMessageId ?? "missing"} status=appended`,
      );
      return record;
    }

    const record = await repository.appendMessageToExistingSession({
      sessionId: input.sessionId,
      runId: input.runId,
      role: input.message.role,
      clientMessageId,
      dedupeKey: input.idempotencyKey,
      parts,
    });
    console.log(
      `[chat/persistence] sessionId=${input.sessionId} runId=${input.runId} messageId=${record.id} role=${record.role} clientMessageId=${record.clientMessageId ?? "missing"} status=appended-existing-session`,
    );
    return record;
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

  private async persistImageAttachments(input: {
    sessionId: string;
    userId?: string;
    message: CoreMessage;
    idempotencyKey: string;
  }): Promise<ChatImageAttachmentRef[]> {
    if (!messageHasImageParts(input.message)) return [];
    if (!input.userId || !this.env.EDIT_ARTIFACTS) {
      throw new Error("Chat image persistence requires an authenticated R2 binding.");
    }

    const store = new ChatMediaStore(this.env.EDIT_ARTIFACTS);
    const images = extractImageParts(input.message.content as unknown[]);
    return await Promise.all(
      images.map((image, index) =>
        store.putImage({
          userId: input.userId!,
          sessionId: input.sessionId,
          // The transcript append is idempotent on this same key. Deriving the
          // object identity from it makes a retried append overwrite the same
          // private object instead of leaking an orphan on every attempt.
          attachmentId: `img_${input.idempotencyKey.slice(0, 48)}_${index}`,
          image,
        }),
      ),
    );
  }
}

function resolveRunStepIndex(
  step: UpsertRunStepInput,
  event: RunEventRecord,
): UpsertRunStepInput {
  if (step.stepIndex > 0) {
    return step;
  }
  return {
    ...step,
    stepIndex: event.sequence,
  };
}

function coreMessageToTranscriptParts(
  message: CoreMessage,
  identity?: TurnScopeBootstrap,
  imageRefs: ChatImageAttachmentRef[] = [],
): Array<{
  type: "text" | "raw";
  content: JsonValue;
}> {
  if (typeof message.content === "string") {
    return [
      {
        type: "text",
        content: buildTranscriptTextContent(message.content, identity),
      },
    ];
  }

  if (messageHasImageParts(message)) {
    return [
      {
        type: "text",
        content: buildTranscriptTextContent(
          buildRedactedMessageText(message),
          identity,
          imageRefs,
        ),
      },
    ];
  }

  return [{ type: "raw", content: toJsonValue(message.content) }];
}

function buildTranscriptTextContent(
  text: string,
  identity?: TurnScopeBootstrap,
  imageRefs: ChatImageAttachmentRef[] = [],
): Record<string, JsonValue> {
  return {
    text,
    ...(identity || imageRefs.length > 0
      ? {
          metadata: {
            ...(identity ? { canonicalIdentity: toJsonValue(identity) } : {}),
            ...(imageRefs.length > 0
              ? { imageAttachments: toJsonValue(imageRefs) }
              : {}),
          },
        }
      : {}),
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value) || typeof value !== "number" ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        output[key] = toJsonValue(item);
      }
    }
    return output;
  }

  return null;
}

function buildPersistenceDedupeContent(message: CoreMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (messageHasImageParts(message)) {
    return buildRedactedMessageText(message);
  }
  return JSON.stringify(message.content);
}

function readClientMessageId(message: CoreMessage): string | null {
  const candidate = message as { id?: unknown };
  return typeof candidate.id === "string" ? candidate.id : null;
}
