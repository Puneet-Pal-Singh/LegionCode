import {
  ResumeTurnReceiptSchema,
  ThreadInputReceiptSchema,
  ThreadIdSchema,
  WorkspaceScopeIdSchema,
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
import { hostedThreadInputRepository } from "../../services/thread-inputs/ThreadInputRepositoryPort";
import { ThreadInputCommandService as HostedTurnAdmissionCommands } from "../../services/thread-inputs/ThreadInputCommandService";
import { ThreadInputCommandService, ThreadInputCommandError, ThreadInputDeliveryResponseError } from "@legioncode/app-server/thread-inputs";
import type { ThreadInputScope, StoredThreadInput } from "@repo/event-store";
import { withTurnAdmissionRepository } from "../../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { ResumeTurnError } from "../../services/turn-admissions/ResumeTurnService";
import type { Env } from "../../types/ai";
import {
  fetchRunProviderModels,
  fetchRunRuntimeRoute,
  resolveExecutionScope,
} from "../../controllers/chat-runtime-helpers";

type HostedThreadInputOperationsService = NonNullable<AppServerComposition["hostedThreadInputOperationsService"]>;
export type HostedThreadInputOutcome<T = unknown> = AppServerMethodOutcome & { result: T };
type InputScope = ThreadInputScope;

/** Hosted placement retains its principal, model, object-store and runtime
 * owners. The shared service owns the command/CAS/delivery policy. */
export function composeHostedThreadInputOperations(request: Request, env: Env, userId: string,
  executionContext?: ExecutionContext): HostedThreadInputOperationsService {
  const correlationId = request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
  const admissions = new HostedTurnAdmissionCommands(env);
  const repository = hostedThreadInputRepository(env);
  const service = new ThreadInputCommandService({
    repository,
    authorize: (identity) => resolveThreadScope(env, userId, identity),
    validateConfiguration: () => undefined,
    prepareMedia: async ({ scope, inputId, clientInputId, mediaRevision, images }) => ({
      references: await persistImages(env, userId, scope.sessionId,
        mediaRevision === 1 ? clientInputId : `${inputId}_${mediaRevision}`, images),
      fingerprint: null, mediaRevision: null, discardUnpublished: async () => undefined,
    }),
    assertSteeringTarget: (scope, target, hasImages, operation) => assertSteeringTarget({ request, env, scope, target, hasImages, operation, correlationId }),
    deliverSteer: (scope, item, operation) => deliverSteer(env, scope, item, operation),
    startQueued: ({ scope, command, explicitStart }) => admissions.startQueuedInput({ request,
      executionContext, userId, sessionId: scope.sessionId, command, correlationId, explicitStart }),
    resume: (scope, command) => admissions.resume({ request, executionContext, userId,
      sessionId: scope.sessionId, command, correlationId }),
  });
  return { execute: async (command) => {
    try {
      // Preserve Hosted's existing update visibility: terminal inbox rows were
      // absent from the original pending/consuming queue snapshot.
      if (command.operation === "thread.input.update") {
        const scope = await resolveThreadScope(env, userId, command);
        const visible = await repository.list(scope);
        if (!visible.items.some((item) => item.itemId === command.itemId))
          throw operationError(404, "not_found", "Queue item not found", "QUEUE_ITEM_NOT_FOUND");
      }
      const result = await service.execute(command);
      const statusCode = (command.operation === "thread.input.update" || command.operation === "thread.input.remove") && result.statusCode === 409
        ? 200 : result.statusCode;
      return outcome(result.result, statusCode);
    } catch (error) {
      if (error instanceof OutcomeError) return error.outcome;
      const mapped = mapThreadInputError(error);
      if (mapped instanceof OutcomeError) return mapped.outcome;
      throw mapped;
    }
  } };
}


async function assertSteeringTarget(input: {
  request: Request; env: Env; scope: ThreadInputScope;
  target: { expectedTurnId: string; expectedRunAttemptId: string }; hasImages: boolean;
  operation: "turn.steer" | "thread.input.steer"; correlationId: string;
}) {
  const { request, env, scope, target, hasImages, operation, correlationId } = input;
  const admission = await withTurnAdmissionRepository(env, (owner) => owner.getByTurnId(target.expectedTurnId));
  if (!admission || admission.state !== "admitted" || admission.userId !== scope.userId ||
      admission.sessionId !== scope.sessionId || admission.threadId !== scope.threadId ||
      admission.workspaceId !== scope.workspaceId || admission.runAttemptId !== target.expectedRunAttemptId) {
    if (operation === "thread.input.steer")
      throw operationError(409, "conflict", "The selected turn is no longer active.", "TURN_NOT_ACTIVE");
    return ThreadInputReceiptSchema.parse({ status: "conflict", code: "turn_not_active", message: "The selected turn is no longer active." }) as Extract<import("@repo/platform-protocol").ThreadInputReceipt, { status: "conflict" }>;
  }
  const runtimeScope = await resolveExecutionScope(request, env, admission.runId, correlationId);
  if (runtimeScope.userId !== scope.userId || runtimeScope.workspaceId !== scope.workspaceId) {
    if (operation === "thread.input.steer")
      throw operationError(409, "conflict", "The selected turn scope has changed.", "TARGET_SUPERSEDED");
    return ThreadInputReceiptSchema.parse({ status: "conflict", code: "target_superseded", message: "The selected turn scope has changed." }) as Extract<import("@repo/platform-protocol").ThreadInputReceipt, { status: "conflict" }>;
  }
  if (hasImages) {
    const run = await withRunRepository(env, (owner) => owner.getRun(admission.runId, scope.userId));
    const modelMetadata = await resolveChatModelMetadata({ providerId: run?.providerId ?? undefined,
      modelId: run?.modelId ?? undefined, fetchModels: (providerId, query) => fetchRunProviderModels(env, {
        runId: admission.runId, userId: scope.userId, workspaceId: scope.workspaceId, providerId, query,
        requestedBackend: "execution-engine-v1",
      }) });
    assertChatImageModelSupport(modelMetadata);
  }
}

async function deliverSteer(env: Env, scope: ThreadInputScope, item: StoredThreadInput, operation: "turn.steer" | "thread.input.steer") {
  const admission = await withTurnAdmissionRepository(env, (owner) => owner.getByTurnId(item.targetTurnId!));
  if (!admission || admission.state !== "admitted" || admission.userId !== scope.userId || admission.sessionId !== scope.sessionId ||
      admission.threadId !== scope.threadId || admission.workspaceId !== scope.workspaceId || admission.runAttemptId !== item.targetRunAttemptId)
    return { status: "conflict" as const, code: "target_superseded" as const, message: "The selected turn scope has changed." };
  const response = await fetchRunRuntimeRoute(env, admission.runId, "execution-engine-v1", {
    method: "POST", path: "/thread/inputs/steer", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: scope.sessionId, userId: scope.userId, runId: admission.runId,
      workspaceId: scope.workspaceId, threadId: scope.threadId, turnId: item.targetTurnId, runAttemptId: item.targetRunAttemptId,
      inputId: item.itemId, clientInputId: item.clientInputId, transcriptMessageId: `thread-input:${item.itemId}`,
      text: item.text, mediaRefs: item.mediaRefs }),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    if (response.status === 409 && (body?.code === "turn_not_active" || body?.code === "target_superseded"))
      return { status: "conflict" as const, code: body.code, message: typeof body.error === "string" ? body.error : "The selected turn no longer accepts input." };
    if (operation === "turn.steer" && response.status < 500)
      throw new ThreadInputDeliveryResponseError(operationError(502, "server_unavailable", "Steering was not confirmed. Retry with the same input ID.", "THREAD_INPUT_NOT_CONFIRMED"));
    throw operationError(503, "server_unavailable", "Steering outcome is being reconciled. Retry with the same input ID.", "THREAD_INPUT_OUTCOME_UNKNOWN");
  }
  const receipt = ThreadInputReceiptSchema.parse({ status: "accepted", clientInputId: item.clientInputId,
    inputId: item.itemId, targetTurnId: item.targetTurnId, targetRunAttemptId: item.targetRunAttemptId, acceptedSequence: Number(body?.acceptedSequence) });
  if (receipt.status !== "accepted") throw new Error("Steering response did not identify its canonical acceptance");
  return { acceptedSequence: receipt.acceptedSequence };
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

function outcome<T>(result: T, statusCode: HostedThreadInputOutcome["statusCode"] = 200): HostedThreadInputOutcome<T> {
  return new AppServerMethodOutcome(statusCode, result) as HostedThreadInputOutcome<T>;
}

function mapThreadInputError(error: unknown): AppServerOperationError | OutcomeError {
  if (error instanceof AppServerOperationError) return error;
  if (error instanceof ThreadInputCommandError)
    return operationError(error.statusCode, errorCategory(error.statusCode), error.message, error.operationCode);
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
