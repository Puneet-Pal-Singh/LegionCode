import type { CoreMessage } from "ai";
import type { JsonValue, TurnActivityTranscriptPart } from "@repo/shared-types";
import type {
  AppendRunEventInput,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunStatus,
  TranscriptRepository,
  UpdateRunStatusInput,
  UpsertRunStepInput,
} from "@repo/persistence";
import { pruneToolResults } from "@shadowbox/context-pruner";
import { Env } from "../types/ai";
import { DomainError } from "../domain/errors";
import { withTranscriptRepository } from "./sessions/TranscriptPersistenceFactory";
import { withRunRepository } from "./runs/RunPersistenceFactory";

interface PersistMessageContext {
  userId?: string;
  workspaceId?: string;
  title?: string;
  repository?: string;
}

type TranscriptPersistenceOperation =
  | "persistUserMessage"
  | "persistAssistantTurn"
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
    taskId?: string | null;
    title?: string | null;
    repository?: string | null;
  }): Promise<void> {
    await withTranscriptRepository(this.env, async (repository) => {
      await repository.ensureSession({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
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

  async updateRunStatus(
    runId: string,
    status: RunStatus,
    startedAt?: string,
    completedAt?: string,
  ): Promise<RunRecord> {
    return await withRunRepository(this.env, async (repository) => {
      return await repository.updateRunStatus({
        id: runId,
        status,
        startedAt,
        completedAt,
      });
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
    status?: UpdateRunStatusInput;
  }): Promise<RunEventRecord> {
    return await withRunRepository(this.env, async (repository) =>
      repository.transaction(async (txRepository) => {
        const event = await txRepository.appendEvent(input.event);
        if (input.step) {
          await txRepository.upsertStep(input.step);
        }
        if (input.status) {
          await txRepository.updateRunStatus(input.status);
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
    } catch (error) {
      console.error("[Brain] Persist user message failed", error);
      throw new TranscriptPersistenceError("persistUserMessage", error);
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

  async persistAssistantTurn(input: {
    sessionId: string;
    runId: string;
    text: string;
    metadata?: Record<string, unknown>;
    activity?: TurnActivityTranscriptPart | null;
  }): Promise<void> {
    try {
      const idempotencyKey = await this.generateIdempotencyKey(
        input.sessionId,
        input.runId,
        "assistant_turn",
        input.text,
      );

      await withTranscriptRepository(this.env, async (repository) => {
        await repository.appendMessageToExistingSession({
          sessionId: input.sessionId,
          runId: input.runId,
          role: "assistant",
          dedupeKey: idempotencyKey,
          parts: buildAssistantTurnParts(input),
        });
      });
      console.log(`[Brain] Persisted assistant turn for run ${input.runId}`);
    } catch (error) {
      console.error("[Brain] Persist assistant turn failed", error);
      throw new TranscriptPersistenceError("persistAssistantTurn", error);
    }
  }

  private async persistLatestConversationMessage(
    sessionId: string,
    runId: string,
    message: CoreMessage,
  ): Promise<void> {
    await withTranscriptRepository(this.env, async (repository) => {
      await repository.transaction(async (txRepo) => {
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
        workspaceId: input.context.workspaceId,
        title: input.context.title,
        repository: input.context.repository,
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

function buildAssistantTurnParts(input: {
  text: string;
  metadata?: Record<string, unknown>;
  activity?: TurnActivityTranscriptPart | null;
}): Array<{ type: "text" | "activity"; content: JsonValue }> {
  const textContent: Record<string, JsonValue> = { text: input.text };
  if (input.metadata) {
    textContent.metadata = toJsonValue(input.metadata);
  }
  const parts: Array<{ type: "text" | "activity"; content: JsonValue }> = [
    { type: "text", content: textContent },
  ];

  if (input.activity && input.activity.events.length > 0) {
    parts.push({ type: "activity", content: toJsonValue(input.activity) });
  }

  return parts;
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

function readClientMessageId(message: CoreMessage): string | null {
  const candidate = message as { id?: unknown };
  return typeof candidate.id === "string" ? candidate.id : null;
}
