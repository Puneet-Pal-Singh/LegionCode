import type { CoreMessage } from "ai";
import type { JsonValue, TurnActivityTranscriptPart } from "@repo/shared-types";
import type {
  AppendRunEventInput,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunStatus,
  TranscriptRepository,
  TranscriptMessageRecord,
  SessionStatus,
  UpdateRunStatusInput,
  UpsertRunStepInput,
} from "@repo/persistence";
import { pruneToolResults } from "@shadowbox/context-pruner";
import { Env } from "../types/ai";
import { DomainError } from "../domain/errors";
import { withTranscriptRepository } from "./sessions/TranscriptPersistenceFactory";
import { withRunRepository } from "./runs/RunPersistenceFactory";
import {
  buildRedactedMessageText,
  messageHasImageParts,
} from "./chat/ImageMessageRedactor";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";

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
    const run = await withRunRepository(this.env, async (repository) => {
      return await repository.updateRunStatus({
        id: runId,
        status,
        startedAt,
        completedAt,
      });
    });
    await this.syncSessionStatus(run, status);
    return run;
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
    const statusUpdate = input.status;
    const event = await withRunRepository(this.env, async (repository) =>
      repository.transaction(async (txRepository) => {
        const event = await txRepository.appendEvent(input.event);
        if (input.step) {
          await txRepository.upsertStep(resolveRunStepIndex(input.step, event));
        }
        if (statusUpdate) {
          await txRepository.updateRunStatus(statusUpdate);
        }
        return event;
      }),
    );
    if (statusUpdate) {
      const run = await withRunRepository(this.env, async (repository) =>
        repository.getRun(statusUpdate.id),
      );
      if (run) {
        await this.syncSessionStatus(run, statusUpdate.status);
      }
    }
    return event;
  }

  private async syncSessionStatus(
    run: RunRecord,
    status: RunStatus,
  ): Promise<void> {
    const sessionStatus = mapRunStatusToSessionStatus(status);
    await withTranscriptRepository(this.env, async (repository) => {
      await repository.updateSessionStatus({
        userId: run.userId,
        sessionId: run.sessionId,
        status: sessionStatus,
      });
    });
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

      const persistedMessage = await this.persistMessage({
        sessionId,
        runId,
        message,
        idempotencyKey,
        context,
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
    turnId?: string | null;
    text: string;
    metadata?: Record<string, unknown>;
    activity?: TurnActivityTranscriptPart | null;
  }): Promise<TranscriptMessageRecord> {
    try {
      const parts = buildAssistantTurnParts(input);
      const turnId = input.turnId ?? readActivityTurnId(input.activity);
      console.log(
        formatDiagnosticLogLine("chat/persistence", "assistant-turn-entered", {
          runId: input.runId,
          sessionId: input.sessionId,
          turnId,
          textChars: input.text.length,
          metadataKeys: Object.keys(input.metadata ?? {}).join(",") || "none",
          activityEventCount: input.activity?.events.length ?? 0,
          activitySnapshotItemCount:
            input.activity?.activitySnapshot.items.length ?? 0,
          activitySnapshotStatus: input.activity?.activitySnapshot.status ?? null,
          partCount: parts.length,
        }),
      );
      const idempotencyKey = await this.generateIdempotencyKey(
        input.sessionId,
        input.runId,
        `assistant_turn:${turnId ?? "unknown_turn"}`,
        input.text,
      );

      const message = await withTranscriptRepository(
        this.env,
        async (repository) => {
          return await repository.appendMessageToExistingSession({
            sessionId: input.sessionId,
            runId: input.runId,
            role: "assistant",
            dedupeKey: idempotencyKey,
            parts,
          });
        },
      );
      console.log(
        formatDiagnosticLogLine(
          "chat/persistence",
          "assistant-turn-persisted",
          {
            runId: input.runId,
            sessionId: input.sessionId,
            turnId,
            persistedMessageId: message.id,
            dedupeKey: idempotencyKey,
            activityEventCount: input.activity?.events.length ?? 0,
            activitySnapshotItemCount:
              input.activity?.activitySnapshot.items.length ?? 0,
            activitySnapshotStatus:
              input.activity?.activitySnapshot.status ?? null,
            partCount: parts.length,
          },
        ),
      );
      return message;
    } catch (error) {
      console.error(
        formatDiagnosticLogLine("chat/persistence", "assistant-turn-failed", {
          runId: input.runId,
          sessionId: input.sessionId,
          turnId: input.turnId ?? readActivityTurnId(input.activity),
          textChars: input.text.length,
          error,
        }),
      );
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
    },
    repository: TranscriptRepository,
  ): Promise<TranscriptMessageRecord> {
    const parts = coreMessageToTranscriptParts(input.message);
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

function mapRunStatusToSessionStatus(status: RunStatus): SessionStatus {
  switch (status) {
    case "created":
      return "idle";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "paused":
      return "paused";
    case "failed":
    case "cancelled":
      return "failed";
  }
}

function coreMessageToTranscriptParts(message: CoreMessage): Array<{
  type: "text" | "raw";
  content: JsonValue;
}> {
  if (typeof message.content === "string") {
    return [{ type: "text", content: { text: message.content } }];
  }

  if (messageHasImageParts(message)) {
    return [
      {
        type: "text",
        content: { text: buildRedactedMessageText(message) },
      },
    ];
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

  if (hasPersistableActivity(input.activity)) {
    parts.push({ type: "activity", content: toJsonValue(input.activity) });
  }

  return parts;
}

function hasPersistableActivity(
  activity: TurnActivityTranscriptPart | null | undefined,
): activity is TurnActivityTranscriptPart {
  if (!activity) {
    return false;
  }
  return (
    activity.events.length > 0 ||
    activity.activitySnapshot.items.length > 0 ||
    activity.activitySnapshot.status !== null
  );
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

function readActivityTurnId(
  activity: TurnActivityTranscriptPart | null | undefined,
): string | null {
  const turnId = activity?.events.find((event) => event.turnId.trim())?.turnId;
  if (turnId?.trim()) {
    return turnId.trim();
  }

  const snapshotTurnId = activity?.activitySnapshot.items.find((item) =>
    item.turnId?.trim(),
  )?.turnId;
  return snapshotTurnId?.trim() || null;
}
