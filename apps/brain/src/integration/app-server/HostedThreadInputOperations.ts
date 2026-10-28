import {
  ResumeTurnReceiptSchema,
  StartQueuedThreadInputCommandSchema,
  ThreadInputReceiptSchema,
  ThreadIdSchema,
  WorkspaceScopeIdSchema,
  type ThreadInputCommand,
} from "@repo/platform-protocol";
import {
  ChatImageAttachmentRefSchema,
} from "@repo/shared-types";
import { ThreadInputConflictError } from "@repo/persistence";
import {
  AppServerOperationError,
  AppServerMethodOutcome,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import { isDomainError, mapDomainErrorToHttp } from "../../domain/errors";
import { ChatMediaStore } from "../../services/chat/ChatMediaStore";
import { resolveChatImageSettings } from "../../services/chat/ChatImageSettings";
import { assertChatImageModelSupport } from "../../services/chat/ChatImageModelPolicy";
import { resolveChatModelMetadata } from "../../services/chat/ChatModelMetadataResolution";
import { withRunRepository } from "../../services/runs/RunPersistenceFactory";
import { withTranscriptRepository } from "../../services/sessions/TranscriptPersistenceFactory";
import { withThreadInputRepository } from "../../services/thread-inputs/ThreadInputPersistenceFactory";
import { ThreadInputCommandService } from "../../services/thread-inputs/ThreadInputCommandService";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { ResumeTurnError } from "../../services/turn-admissions/ResumeTurnService";
import type { Env } from "../../types/ai";
import {
  fetchRunProviderModels,
  fetchRunRuntimeRoute,
  resolveExecutionScope,
} from "../../controllers/chat-runtime-helpers";

type HostedThreadInputOperationsService = NonNullable<
  AppServerComposition["hostedThreadInputOperationsService"]
>;

export type HostedThreadInputOutcome<T = unknown> = AppServerMethodOutcome & { result: T };

type InputScope = {
  sessionId: string;
  userId: string;
  threadId: string;
  workspaceId: string;
};

/** Existing thread input owners composed with the App Server's verified principal. */
export function composeHostedThreadInputOperations(
  request: Request,
  env: Env,
  userId: string,
  executionContext?: ExecutionContext,
): HostedThreadInputOperationsService {
  return {
    execute: async (command) => {
      try {
        return await executeCommand({ request, env, userId, executionContext, command });
      } catch (error) {
        if (error instanceof OutcomeError) return error.outcome;
        const mapped = mapThreadInputError(error);
        if (mapped instanceof OutcomeError) return mapped.outcome;
        throw mapped;
      }
    },
  };
}

async function executeCommand(input: {
  request: Request;
  env: Env;
  userId: string;
  executionContext?: ExecutionContext;
  command: ThreadInputCommand;
}): Promise<HostedThreadInputOutcome> {
  const { command, env, request, userId, executionContext } = input;
  const correlationId = request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  switch (command.operation) {
    case "turn.resume": {
      const scope = await resolveThreadScope(env, userId, command);
      const result = await new ThreadInputCommandService(env).resume({
        request,
        executionContext,
        userId,
        sessionId: scope.sessionId,
        command,
        correlationId,
      });
      return outcome(result, 202);
    }
    case "thread.input.list": {
      const scope = await resolveThreadScope(env, userId, command);
      const result = await withThreadInputRepository(env, (repository) =>
        repository.list(scope),
      );
      return outcome(result);
    }
    case "turn.steer":
      return steerTurn({ ...input, command, correlationId });
    case "thread.input.enqueue":
      return enqueueThreadInput({ ...input, command, correlationId });
    case "thread.input.start": {
      const scope = await resolveThreadScope(env, userId, command);
      const result = await new ThreadInputCommandService(env).startQueuedInput({
        request,
        executionContext,
        userId,
        sessionId: scope.sessionId,
        command,
        correlationId,
      });
      return outcome(result, result.status === "conflict" ? 409 : 202);
    }
    case "thread.input.steer":
      return steerQueuedThreadInput({ ...input, command, correlationId });
    case "thread.input.update": {
      const scope = await resolveThreadScope(env, userId, command);
      const current = await withThreadInputRepository(env, (repository) =>
        repository.list(scope),
      );
      const existing = current.items.find((item) => item.itemId === command.itemId);
      if (!existing) {
        throw operationError(404, "not_found", "Queue item not found", "QUEUE_ITEM_NOT_FOUND");
      }
      const effectiveImages = command.content.images ?? existing.mediaRefs;
      if (!command.content.text.trim() && effectiveImages.length === 0) {
        throw operationError(400, "invalid_request", "Provide text or at least one image.", "THREAD_INPUT_CONTENT_INVALID");
      }
      const mediaRefs = command.content.images
        ? await persistImages(
            env,
            userId,
            scope.sessionId,
            `${command.itemId}_${command.expectedVersion + 1}`,
            command.content.images,
          )
        : undefined;
      const result = await withThreadInputRepository(env, (repository) =>
        repository.update({
          ...scope,
          itemId: command.itemId,
          expectedVersion: command.expectedVersion,
          text: command.content.text,
          ...(mediaRefs ? { mediaRefs } : {}),
          ...(command.configuration ? { configuration: command.configuration } : {}),
        }),
      );
      return outcome(mutationReceipt(result));
    }
    case "thread.input.remove": {
      const scope = await resolveThreadScope(env, userId, command);
      const result = await withThreadInputRepository(env, (repository) =>
        repository.remove({
          ...scope,
          itemId: command.itemId,
          expectedVersion: command.expectedVersion,
        }),
      );
      return outcome(mutationReceipt(result));
    }
  }
}

async function steerTurn(input: {
  request: Request;
  env: Env;
  userId: string;
  command: Extract<ThreadInputCommand, { operation: "turn.steer" }>;
  correlationId: string;
}): Promise<HostedThreadInputOutcome> {
  const { command, env, request, userId, correlationId } = input;
  const scope = await resolveThreadScope(env, userId, command);
  const admission = await withTurnAdmissionRepository(env, (repository) =>
    repository.getByTurnId(command.expectedTurnId),
  );
  if (
    !admission || admission.state !== "admitted" ||
    admission.userId !== userId || admission.sessionId !== scope.sessionId ||
    admission.threadId !== command.threadId || admission.workspaceId !== command.workspaceId ||
    admission.runAttemptId !== command.expectedRunAttemptId
  ) {
    return outcome(ThreadInputReceiptSchema.parse({
      status: "conflict",
      code: "turn_not_active",
      message: "The selected turn is no longer active.",
    }), 409);
  }
  const runtimeScope = await resolveExecutionScope(request, env, admission.runId, correlationId);
  if (runtimeScope.userId !== userId || runtimeScope.workspaceId !== command.workspaceId) {
    return outcome(ThreadInputReceiptSchema.parse({
      status: "conflict",
      code: "target_superseded",
      message: "The selected turn scope has changed.",
    }), 409);
  }
  if (command.content.images.length > 0) {
    const run = await withRunRepository(env, (repository) =>
      repository.getRun(admission.runId, userId),
    );
    const modelMetadata = await resolveChatModelMetadata({
      providerId: run?.providerId ?? undefined,
      modelId: run?.modelId ?? undefined,
      fetchModels: (providerId, query) =>
        fetchRunProviderModels(env, {
          runId: admission.runId,
          userId,
          workspaceId: command.workspaceId,
          providerId,
          query,
          requestedBackend: "execution-engine-v1",
        }),
    });
    assertChatImageModelSupport(modelMetadata);
  }
  const mediaRefs = await persistImages(
    env,
    userId,
    scope.sessionId,
    command.clientInputId,
    command.content.images,
  );
  const fingerprint = await sha256(JSON.stringify({
    operation: command.operation,
    text: command.content.text,
    mediaRefs,
    targetTurnId: command.expectedTurnId,
    targetRunAttemptId: command.expectedRunAttemptId,
  }));
  const stored = await withThreadInputRepository(env, (repository) =>
    repository.enqueue({
      ...scope,
      clientInputId: command.clientInputId,
      fingerprint,
      delivery: "steer",
      targetTurnId: command.expectedTurnId,
      targetRunAttemptId: command.expectedRunAttemptId,
      text: command.content.text,
      mediaRefs,
      configuration: {},
    }),
  );
  const existing = stored.item.receipt;
  if (existing && ["accepted", "applied", "unconfirmed"].includes(existing.status)) {
    return outcome(existing);
  }
  const runtimeResponse = await fetchRunRuntimeRoute(env, admission.runId, "execution-engine-v1", {
    method: "POST",
    path: "/thread/inputs/steer",
    body: JSON.stringify({
      sessionId: scope.sessionId,
      userId,
      runId: admission.runId,
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      turnId: command.expectedTurnId,
      runAttemptId: command.expectedRunAttemptId,
      inputId: stored.item.itemId,
      clientInputId: command.clientInputId,
      transcriptMessageId: `thread-input:${stored.item.itemId}`,
      text: command.content.text,
      mediaRefs,
    }),
    headers: { "Content-Type": "application/json" },
  });
  const runtimeBody = await runtimeResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!runtimeResponse.ok) {
    if (runtimeResponse.status >= 500) {
      throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry with the same input ID.", "THREAD_INPUT_OUTCOME_UNKNOWN");
    }
    if (runtimeResponse.status !== 409 ||
      (runtimeBody?.code !== "turn_not_active" && runtimeBody?.code !== "target_superseded")) {
      throw operationError(502, "server_unavailable", "Steering was not confirmed. Retry with the same input ID.", "THREAD_INPUT_NOT_CONFIRMED");
    }
    const conflict = ThreadInputReceiptSchema.parse({
      status: "conflict",
      code: runtimeBody.code,
      message: typeof runtimeBody.error === "string" ? runtimeBody.error : "The selected turn no longer accepts input.",
    });
    await withThreadInputRepository(env, (repository) => repository.recordReceipt({
      ...scope,
      itemId: stored.item.itemId,
      expectedVersion: stored.item.version,
      receipt: conflict,
      state: "cancelled",
    }));
    return outcome(conflict, 409);
  }
  const acceptedSequence = Number(runtimeBody?.acceptedSequence);
  ThreadInputReceiptSchema.parse({
    status: "accepted",
    clientInputId: command.clientInputId,
    inputId: stored.item.itemId,
    targetTurnId: command.expectedTurnId,
    targetRunAttemptId: command.expectedRunAttemptId,
    acceptedSequence,
  });
  const authoritative = await withThreadInputRepository(env, (repository) =>
    repository.getById({ ...scope, itemId: stored.item.itemId }),
  );
  const authoritativeReceipt = authoritative?.receipt;
  if (!authoritativeReceipt) {
    throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry with the same input ID.", "THREAD_INPUT_OUTCOME_UNKNOWN");
  }
  if (authoritativeReceipt.status === "unconfirmed") return outcome(authoritativeReceipt);
  if (authoritativeReceipt.status === "accepted" || authoritativeReceipt.status === "applied") {
    if (authoritativeReceipt.acceptedSequence !== acceptedSequence) {
      throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry with the same input ID.", "THREAD_INPUT_OUTCOME_UNKNOWN");
    }
  } else {
    throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry with the same input ID.", "THREAD_INPUT_OUTCOME_UNKNOWN");
  }
  return outcome(authoritativeReceipt, stored.duplicate ? 200 : 202);
}

async function enqueueThreadInput(input: {
  request: Request;
  env: Env;
  userId: string;
  executionContext?: ExecutionContext;
  command: Extract<ThreadInputCommand, { operation: "thread.input.enqueue" }>;
  correlationId: string;
}): Promise<HostedThreadInputOutcome> {
  const { command, env, request, userId, executionContext, correlationId } = input;
  const scope = await resolveThreadScope(env, userId, command);
  const mediaRefs = await persistImages(
    env,
    userId,
    scope.sessionId,
    command.clientInputId,
    command.content.images,
  );
  const fingerprint = await sha256(JSON.stringify({
    operation: command.operation,
    text: command.content.text,
    mediaRefs,
    configuration: command.configuration,
  }));
  const result = await withThreadInputRepository(env, (repository) =>
    repository.enqueue({
      ...scope,
      clientInputId: command.clientInputId,
      fingerprint,
      delivery: "queue",
      text: command.content.text,
      mediaRefs,
      configuration: command.configuration,
    }),
  );
  const receipt = result.item.receipt ?? ThreadInputReceiptSchema.parse({
    status: "pending",
    clientInputId: result.item.clientInputId,
    itemId: result.item.itemId,
    order: result.item.order,
    version: result.item.version,
    revision: result.revision,
  });
  if (result.item.state === "pending") {
    const queueSnapshot = await withThreadInputRepository(env, (repository) =>
      repository.list(scope),
    );
    if (!queueSnapshot.activeRunId) {
      const next = queueSnapshot.items.find((candidate) =>
        candidate.delivery === "queue" && candidate.state === "pending",
      );
      if (next) {
        try {
          await new ThreadInputCommandService(env).startQueuedInput({
            request,
            executionContext,
            userId,
            sessionId: scope.sessionId,
            correlationId,
            explicitStart: false,
            command: StartQueuedThreadInputCommandSchema.parse({
              operation: "thread.input.start",
              threadId: command.threadId,
              workspaceId: command.workspaceId,
              itemId: next.itemId,
              expectedVersion: next.version,
              expectedThreadRevision: queueSnapshot.revision,
            }),
          });
        } catch (error) {
          console.error("[thread-input/auto-start] queued input remains pending", {
            correlationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  return outcome(receipt, result.duplicate ? 200 : 201);
}

async function steerQueuedThreadInput(input: {
  request: Request;
  env: Env;
  userId: string;
  command: Extract<ThreadInputCommand, { operation: "thread.input.steer" }>;
  correlationId: string;
}): Promise<HostedThreadInputOutcome> {
  const { command, env, request, userId, correlationId } = input;
  const scope = await resolveThreadScope(env, userId, command);
  const item = await withThreadInputRepository(env, (repository) =>
    repository.getById({ ...scope, itemId: command.itemId }),
  );
  if (!item) {
    throw operationError(404, "not_found", "Queue item not found", "QUEUE_ITEM_NOT_FOUND");
  }
  if (item.delivery === "steer" && (
    item.targetTurnId !== command.expectedTurnId ||
    item.targetRunAttemptId !== command.expectedRunAttemptId
  )) {
    return outcome(ThreadInputReceiptSchema.parse({
      status: "conflict",
      code: "target_superseded",
      message: "This input is already bound to a different turn attempt.",
    }), 409);
  }
  if (item.delivery === "steer" && item.receipt &&
    ["accepted", "applied", "unconfirmed"].includes(item.receipt.status)) {
    return outcome(item.receipt);
  }
  const admission = await withTurnAdmissionRepository(env, (repository) =>
    repository.getByTurnId(command.expectedTurnId),
  );
  if (
    !admission || admission.state !== "admitted" || admission.userId !== userId ||
    admission.sessionId !== scope.sessionId || admission.threadId !== command.threadId ||
    admission.workspaceId !== command.workspaceId ||
    admission.runAttemptId !== command.expectedRunAttemptId
  ) {
    throw operationError(409, "conflict", "The selected turn is no longer active.", "TURN_NOT_ACTIVE");
  }
  const runtimeScope = await resolveExecutionScope(request, env, admission.runId, correlationId);
  if (runtimeScope.userId !== userId || runtimeScope.workspaceId !== command.workspaceId) {
    throw operationError(409, "conflict", "The selected turn scope has changed.", "TARGET_SUPERSEDED");
  }
  if (item.mediaRefs.length > 0) {
    const run = await withRunRepository(env, (repository) =>
      repository.getRun(admission.runId, userId),
    );
    const modelMetadata = await resolveChatModelMetadata({
      providerId: run?.providerId ?? undefined,
      modelId: run?.modelId ?? undefined,
      fetchModels: (providerId, query) => fetchRunProviderModels(env, {
        runId: admission.runId,
        userId,
        workspaceId: command.workspaceId,
        providerId,
        query,
        requestedBackend: "execution-engine-v1",
      }),
    });
    assertChatImageModelSupport(modelMetadata);
  }
  let expectedReceiptVersion = item.version;
  if (item.delivery === "queue") {
    const claimed = await withThreadInputRepository(env, (repository) =>
      repository.claimForSteering({
        ...scope,
        itemId: command.itemId,
        expectedVersion: command.expectedVersion,
        targetTurnId: command.expectedTurnId,
        targetRunAttemptId: command.expectedRunAttemptId,
      }),
    );
    if (claimed.status === "conflict") {
      return outcome(ThreadInputReceiptSchema.parse({
        status: "conflict",
        code: claimed.code,
        message: "Queue item changed or was already consumed.",
      }), 409);
    }
    expectedReceiptVersion = claimed.item.version;
  }
  const runtimeResponse = await fetchRunRuntimeRoute(env, admission.runId, "execution-engine-v1", {
    method: "POST",
    path: "/thread/inputs/steer",
    body: JSON.stringify({
      sessionId: scope.sessionId,
      userId,
      runId: admission.runId,
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      turnId: command.expectedTurnId,
      runAttemptId: command.expectedRunAttemptId,
      inputId: item.itemId,
      clientInputId: item.clientInputId,
      transcriptMessageId: `thread-input:${item.itemId}`,
      text: item.text,
      mediaRefs: item.mediaRefs,
    }),
    headers: { "Content-Type": "application/json" },
  });
  const runtimeBody = await runtimeResponse.json().catch(() => null) as Record<string, unknown> | null;
  if (!runtimeResponse.ok) {
    if (runtimeResponse.status >= 500 || runtimeResponse.status !== 409 ||
      (runtimeBody?.code !== "turn_not_active" && runtimeBody?.code !== "target_superseded")) {
      throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry from the current queue snapshot.", "THREAD_INPUT_OUTCOME_UNKNOWN");
    }
    const code = runtimeBody.code === "target_superseded" ? "target_superseded" : "turn_not_active";
    const conflict = ThreadInputReceiptSchema.parse({
      status: "conflict",
      code,
      message: typeof runtimeBody.error === "string" ? runtimeBody.error : "The selected turn no longer accepts input.",
    });
    await withThreadInputRepository(env, (repository) => repository.recordReceipt({
      ...scope,
      itemId: command.itemId,
      expectedVersion: expectedReceiptVersion,
      receipt: conflict,
      state: "cancelled",
    }));
    return outcome(conflict, 409);
  }
  const acceptedSequence = Number(runtimeBody?.acceptedSequence);
  ThreadInputReceiptSchema.parse({
    status: "accepted",
    clientInputId: item.clientInputId,
    inputId: item.itemId,
    targetTurnId: command.expectedTurnId,
    targetRunAttemptId: command.expectedRunAttemptId,
    acceptedSequence,
  });
  const authoritative = await withThreadInputRepository(env, (repository) =>
    repository.getById({ ...scope, itemId: command.itemId }),
  );
  const authoritativeReceipt = authoritative?.receipt;
  if (!authoritativeReceipt) {
    throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry from the current queue snapshot.", "THREAD_INPUT_OUTCOME_UNKNOWN");
  }
  if (authoritativeReceipt.status === "unconfirmed") return outcome(authoritativeReceipt);
  if (authoritativeReceipt.status === "accepted" || authoritativeReceipt.status === "applied") {
    if (authoritativeReceipt.acceptedSequence !== acceptedSequence) {
      throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry from the current queue snapshot.", "THREAD_INPUT_OUTCOME_UNKNOWN");
    }
  } else {
    throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry from the current queue snapshot.", "THREAD_INPUT_OUTCOME_UNKNOWN");
  }
  return outcome(authoritativeReceipt, 202);
}

async function resolveThreadScope(
  env: Env,
  userId: string,
  identity: { threadId: string; workspaceId: string },
): Promise<InputScope> {
  const threadId = ThreadIdSchema.parse(identity.threadId);
  const workspaceId = WorkspaceScopeIdSchema.parse(identity.workspaceId);
  const session = await withTranscriptRepository(env, async (repository) => {
    const result = await repository.listSessions(userId);
    return result.sessions.find((candidate) => candidate.threadId === threadId) ?? null;
  });
  if (!session || session.workspaceId !== workspaceId) {
    throw new ThreadInputConflictError(
      "Conversation thread or workspace scope does not match",
      "thread_scope_conflict",
    );
  }
  return { sessionId: session.id, userId, threadId, workspaceId };
}

async function persistImages(
  env: Env,
  userId: string,
  sessionId: string,
  idempotencyKey: string,
  images: readonly { dataUrl: string; name: string; mediaType: string }[],
) {
  if (!images.length) return [];
  if (!env.EDIT_ARTIFACTS) throw new Error("Image storage is unavailable");
  const store = new ChatMediaStore(env.EDIT_ARTIFACTS, resolveChatImageSettings(env));
  const refs = [];
  for (const [index, image] of images.entries()) {
    const attachmentId = `in_${(await sha256(`${idempotencyKey}:${index}:${image.dataUrl}`)).slice(0, 32)}`;
    refs.push(ChatImageAttachmentRefSchema.parse(await store.putImage({
      userId,
      sessionId,
      attachmentId,
      image: { image: image.dataUrl, name: image.name, mediaType: image.mediaType },
    })));
  }
  return refs;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mutationReceipt(
  result: Awaited<ReturnType<import("@repo/persistence").ThreadInputRepository["remove"]>>,
) {
  if (result.status === "conflict") {
    return ThreadInputReceiptSchema.parse({
      status: "conflict",
      code: result.code,
      message: "Queue item changed or was already consumed.",
    });
  }
  return result.item.receipt ?? {
    status: "pending" as const,
    clientInputId: result.item.clientInputId,
    itemId: result.item.itemId,
    order: result.item.order,
    version: result.item.version,
    revision: result.revision,
  };
}

function outcome<T>(result: T, statusCode: HostedThreadInputOutcome["statusCode"] = 200): HostedThreadInputOutcome<T> {
  return new AppServerMethodOutcome(statusCode, result) as HostedThreadInputOutcome<T>;
}

function mapThreadInputError(error: unknown): AppServerOperationError | OutcomeError {
  if (error instanceof AppServerOperationError) return error;
  if (error instanceof ResumeTurnError) {
    if (error.status === 409) {
      const code = error.code.includes("snapshot")
        ? "workspace_snapshot_unavailable"
        : "target_superseded";
      const receipt = ResumeTurnReceiptSchema.parse({
        status: "conflict",
        code,
        message: error.message,
      });
      return new OutcomeError(outcome(receipt, 409));
    }
    return operationError(
      error.status,
      errorCategory(error.status),
      error.message,
      error.code.toUpperCase(),
    );
  }
  if (isDomainError(error)) {
    const mapped = mapDomainErrorToHttp(error);
    return operationError(
      mapped.status,
      errorCategory(mapped.status),
      mapped.message,
      mapped.code,
      undefined,
      undefined,
      mapped.metadata,
    );
  }
  if (error instanceof ThreadInputConflictError) {
    if (error.code === "queue_item_changed" || error.code === "queue_item_consumed") {
      const receipt = ThreadInputReceiptSchema.parse({
        status: "conflict",
        code: error.code,
        message: error.message,
      });
      return new OutcomeError(outcome(receipt, 409));
    }
    return operationError(409, "conflict", error.message, error.code.toUpperCase());
  }
  return operationError(500, "server_unavailable", "Thread input operation failed", "THREAD_INPUT_FAILED", true);
}

class OutcomeError extends Error {
  constructor(readonly outcome: HostedThreadInputOutcome) {
    super("Thread input command returned a conflict receipt");
  }
}

function operationError(
  statusCode: number,
  category: ConstructorParameters<typeof AppServerOperationError>[1],
  message: string,
  operationCode: string,
  retryable?: boolean,
  correlationId?: string,
  metadata?: Record<string, unknown>,
): AppServerOperationError {
  return new AppServerOperationError(
    statusCode,
    category,
    message,
    operationCode,
    retryable,
    correlationId,
    metadata,
  );
}

function errorCategory(status: number): ConstructorParameters<typeof AppServerOperationError>[1] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server_unavailable";
  return "invalid_request";
}
