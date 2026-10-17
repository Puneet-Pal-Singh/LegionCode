import {
  EnqueueThreadInputCommandSchema,
  ListThreadInputsCommandSchema,
  RemoveThreadInputCommandSchema,
  ResumeTurnCommandSchema,
  ResumeTurnReceiptSchema,
  SteerQueuedThreadInputCommandSchema,
  StartQueuedThreadInputCommandSchema,
  ThreadInputReceiptSchema,
  SteerTurnCommandSchema,
  UpdateThreadInputCommandSchema,
  WorkspaceScopeIdSchema,
  type ThreadInputCommand,
} from "@repo/platform-protocol";
import { z } from "zod";
import { ThreadIdSchema } from "@repo/platform-protocol";
import { ChatImageAttachmentRefSchema } from "@repo/shared-types";
import { ThreadInputConflictError } from "@repo/persistence";
import { errorResponse, jsonResponse } from "../http/response";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import { isDomainError, mapDomainErrorToHttp } from "../domain/errors";
import type { Env } from "../types/ai";
import { getAuthenticatedUserSession } from "../services/AuthService";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";
import { withThreadInputRepository } from "../services/thread-inputs/ThreadInputPersistenceFactory";
import { ChatMediaStore } from "../services/chat/ChatMediaStore";
import { resolveChatImageSettings } from "../services/chat/ChatImageSettings";
import { withTurnAdmissionRepository } from "../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { withRunRepository } from "../services/runs/RunPersistenceFactory";
import { assertChatImageModelSupport } from "../services/chat/ChatImageModelPolicy";
import { ResumeTurnError } from "../services/turn-admissions/ResumeTurnService";
import { ThreadInputCommandService } from "../services/thread-inputs/ThreadInputCommandService";
import { resolveChatModelMetadata } from "../services/chat/ChatModelMetadataResolution";
import {
  resolveExecutionScope,
  fetchRunProviderModels,
  fetchRunRuntimeRoute,
} from "./chat-runtime-helpers";

/** Authenticated durable inbox endpoints. Runtime decisions stay with the turn owner. */
export class ThreadInputController {
  static async handle(request: Request, env: Env, executionContext?: ExecutionContext): Promise<Response> {
    const correlationId = request.headers.get("X-Correlation-Id") ?? crypto.randomUUID();
    try {
      const url = new URL(request.url);
      const user = await getAuthenticatedUserSession(request, env);
      if (!user) return errorResponse(request, env, "Unauthorized", 401, "AUTH_FAILED");

      if (url.pathname === "/turn/resume" && request.method === "POST") {
        const body = validateWithSchema<z.infer<typeof ResumeTurnCommandSchema>>(
          await parseRequestBody(request, correlationId), ResumeTurnCommandSchema, correlationId,
        );
        const scope = await resolveThreadScope(env, user.userId, body);
        const receipt = await new ThreadInputCommandService(env).resume({
          request, executionContext, userId: user.userId, sessionId: scope.sessionId,
          command: body, correlationId,
        });
        return jsonResponse(request, env, receipt, { status: 202 });
      }

      if (url.pathname === "/thread/inputs" && request.method === "GET") {
        const query = validateWithSchema<z.infer<typeof ListThreadInputsCommandSchema>>({
          operation: "thread.input.list",
          threadId: url.searchParams.get("threadId"),
          workspaceId: url.searchParams.get("workspaceId"),
          ...(url.searchParams.has("knownRevision")
            ? { knownRevision: Number(url.searchParams.get("knownRevision")) }
            : {}),
        }, ListThreadInputsCommandSchema, correlationId);
        const scope = await resolveThreadScope(env, user.userId, query);
        return jsonResponse(request, env, await withThreadInputRepository(env, (repository) => repository.list(scope)));
      }

      if (url.pathname === "/turn/steer" && request.method === "POST") {
        const body = validateWithSchema<z.infer<typeof SteerTurnCommandSchema>>(
          await parseRequestBody(request, correlationId),
          SteerTurnCommandSchema,
          correlationId,
        );
        const scope = await resolveThreadScope(env, user.userId, body);
        const admission = await withTurnAdmissionRepository(env, (repository) =>
          repository.getByTurnId(body.expectedTurnId),
        );
        if (
          !admission || admission.state !== "admitted" ||
          admission.userId !== user.userId || admission.sessionId !== scope.sessionId ||
          admission.threadId !== body.threadId || admission.workspaceId !== body.workspaceId ||
          admission.runAttemptId !== body.expectedRunAttemptId
        ) {
          return jsonResponse(request, env, ThreadInputReceiptSchema.parse({
            status: "conflict", code: "turn_not_active", message: "The selected turn is no longer active.",
          }), { status: 409 });
        }
        const runtimeScope = await resolveExecutionScope(request, env, admission.runId, correlationId);
        if (runtimeScope.userId !== user.userId || runtimeScope.workspaceId !== body.workspaceId) {
          return jsonResponse(request, env, ThreadInputReceiptSchema.parse({
            status: "conflict", code: "target_superseded", message: "The selected turn scope has changed.",
          }), { status: 409 });
        }
        if (body.content.images.length > 0) {
          const run = await withRunRepository(env, (repository) =>
            repository.getRun(admission.runId, user.userId),
          );
          const modelMetadata = await resolveChatModelMetadata({
            providerId: run?.providerId ?? undefined,
            modelId: run?.modelId ?? undefined,
            fetchModels: (providerId, query) =>
              fetchRunProviderModels(env, {
                runId: admission.runId,
                userId: user.userId,
                workspaceId: body.workspaceId,
                providerId,
                query,
                requestedBackend: "execution-engine-v1",
              }),
          });
          assertChatImageModelSupport(modelMetadata);
        }
        const mediaRefs = await persistImages(env, user.userId, scope.sessionId, body.clientInputId, body.content.images);
        const fingerprint = await sha256(JSON.stringify({
          operation: body.operation,
          text: body.content.text,
          mediaRefs,
          targetTurnId: body.expectedTurnId,
          targetRunAttemptId: body.expectedRunAttemptId,
        }));
        const stored = await withThreadInputRepository(env, (repository) => repository.enqueue({
          ...scope,
          clientInputId: body.clientInputId,
          fingerprint,
          delivery: "steer",
          targetTurnId: body.expectedTurnId,
          targetRunAttemptId: body.expectedRunAttemptId,
          text: body.content.text,
          mediaRefs,
          configuration: {},
        }));
        if (stored.item.receipt?.status === "accepted" || stored.item.receipt?.status === "applied" || stored.item.receipt?.status === "unconfirmed") {
          return jsonResponse(request, env, stored.item.receipt);
        }
        const transcriptMessageId = `thread-input:${stored.item.itemId}`;
        const runtimeResponse = await fetchRunRuntimeRoute(env, admission.runId, "execution-engine-v1", {
          method: "POST",
          path: "/thread/inputs/steer",
          body: JSON.stringify({
            sessionId: scope.sessionId,
            userId: user.userId,
            runId: admission.runId,
            workspaceId: body.workspaceId,
            threadId: body.threadId,
            turnId: body.expectedTurnId,
            runAttemptId: body.expectedRunAttemptId,
            inputId: stored.item.itemId,
            clientInputId: body.clientInputId,
            transcriptMessageId,
            text: body.content.text,
            mediaRefs,
          }),
          headers: { "Content-Type": "application/json" },
        });
        const runtimeBody = await runtimeResponse.json().catch(() => null) as Record<string, unknown> | null;
        if (!runtimeResponse.ok) {
          if (runtimeResponse.status >= 500) {
            return errorResponse(request, env, "Steering outcome is being reconciled. Retry with the same input ID.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
          }
          if (runtimeResponse.status !== 409 ||
            (runtimeBody?.code !== "turn_not_active" && runtimeBody?.code !== "target_superseded")) {
            return errorResponse(request, env, "Steering was not confirmed. Retry with the same input ID.", 502, "THREAD_INPUT_NOT_CONFIRMED");
          }
          const code = runtimeBody.code;
          const conflict = ThreadInputReceiptSchema.parse({
            status: "conflict", code,
            message: typeof runtimeBody?.error === "string" ? runtimeBody.error : "The selected turn no longer accepts input.",
          });
          await withThreadInputRepository(env, (repository) => repository.recordReceipt({
            ...scope,
            itemId: stored.item.itemId,
            expectedVersion: stored.item.version,
            receipt: conflict,
            state: "cancelled",
          }));
          return jsonResponse(request, env, conflict, { status: 409 });
        }
        const acceptedSequence = Number(runtimeBody?.acceptedSequence);
        const receipt = ThreadInputReceiptSchema.parse({
          status: "accepted",
          clientInputId: body.clientInputId,
          inputId: stored.item.itemId,
          targetTurnId: body.expectedTurnId,
          targetRunAttemptId: body.expectedRunAttemptId,
          acceptedSequence,
        });
        const authoritative = await withThreadInputRepository(env, (repository) => repository.getById({
          ...scope,
          itemId: stored.item.itemId,
        }));
        const authoritativeReceipt = authoritative?.receipt;
        if (!authoritativeReceipt) {
          return errorResponse(request, env, "Steering outcome is being reconciled. Retry with the same input ID.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
        }
        if (authoritativeReceipt.status === "unconfirmed") return jsonResponse(request, env, authoritativeReceipt);
        if (authoritativeReceipt.status === "accepted" || authoritativeReceipt.status === "applied") {
          if (authoritativeReceipt.acceptedSequence !== acceptedSequence) {
            return errorResponse(request, env, "Steering outcome is being reconciled. Retry with the same input ID.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
          }
        } else {
          return errorResponse(request, env, "Steering outcome is being reconciled. Retry with the same input ID.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
        }
        return jsonResponse(request, env, authoritativeReceipt, { status: stored.duplicate ? 200 : 202 });
      }

      if (url.pathname === "/thread/inputs" && request.method === "POST") {
        const body = validateWithSchema<z.infer<typeof EnqueueThreadInputCommandSchema>>(
          await parseRequestBody(request, correlationId),
          EnqueueThreadInputCommandSchema,
          correlationId,
        );
        const scope = await resolveThreadScope(env, user.userId, body);
        const mediaRefs = await persistImages(env, user.userId, scope.sessionId, body.clientInputId, body.content.images);
        const fingerprint = await sha256(JSON.stringify({
          operation: body.operation,
          text: body.content.text,
          mediaRefs,
          configuration: body.configuration,
        }));
        const result = await withThreadInputRepository(env, (repository) => repository.enqueue({
          ...scope,
          clientInputId: body.clientInputId,
          fingerprint,
          delivery: "queue",
          text: body.content.text,
          mediaRefs,
          configuration: body.configuration,
        }));
        const receipt = result.item.receipt ?? ThreadInputReceiptSchema.parse({
          status: "pending",
          clientInputId: result.item.clientInputId,
          itemId: result.item.itemId,
          order: result.item.order,
          version: result.item.version,
          revision: result.revision,
        });
        if (result.item.state === "pending") {
          const queueSnapshot = await withThreadInputRepository(env, (repository) => repository.list(scope));
          if (!queueSnapshot.activeRunId) {
            const next = queueSnapshot.items.find((candidate) => candidate.delivery === "queue" && candidate.state === "pending");
            if (next) {
              try {
                await new ThreadInputCommandService(env).startQueuedInput({
                  request,
                  executionContext,
                  userId: user.userId,
                  sessionId: scope.sessionId,
                  correlationId,
                  explicitStart: false,
                  command: StartQueuedThreadInputCommandSchema.parse({
                    operation: "thread.input.start",
                    threadId: body.threadId,
                    workspaceId: body.workspaceId,
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
        return jsonResponse(request, env, receipt, { status: result.duplicate ? 200 : 201 });
      }

      const itemPath = /^\/thread\/inputs\/([^/]+)(?:\/(steer|start))?$/.exec(url.pathname);
      if (!itemPath) return errorResponse(request, env, "Not Found", 404);
      const itemId = decodeURIComponent(itemPath[1]!);
      const operation = itemPath[2];
      if (operation === "start" && request.method === "POST") {
        const body = validateWithSchema<z.infer<typeof StartQueuedThreadInputCommandSchema>>(
          await parseRequestBody(request, correlationId),
          StartQueuedThreadInputCommandSchema,
          correlationId,
        );
        if (body.itemId !== itemId) return errorResponse(request, env, "Queue item path does not match request body", 400, "QUEUE_ITEM_PATH_MISMATCH");
        const scope = await resolveThreadScope(env, user.userId, body);
        const receipt = await new ThreadInputCommandService(env).startQueuedInput({
          request,
          executionContext,
          userId: user.userId,
          sessionId: scope.sessionId,
          command: body,
          correlationId,
        });
        return jsonResponse(request, env, receipt, { status: receipt.status === "conflict" ? 409 : 202 });
      }
      if (operation === "steer" && request.method === "POST") {
        const body = validateWithSchema<z.infer<typeof SteerQueuedThreadInputCommandSchema>>(
          await parseRequestBody(request, correlationId),
          SteerQueuedThreadInputCommandSchema,
          correlationId,
        );
        if (body.itemId !== itemId) return errorResponse(request, env, "Queue item path does not match request body", 400, "QUEUE_ITEM_PATH_MISMATCH");
        const scope = await resolveThreadScope(env, user.userId, body);
        const item = await withThreadInputRepository(env, (repository) => repository.getById({ ...scope, itemId }));
        if (!item) return errorResponse(request, env, "Queue item not found", 404, "QUEUE_ITEM_NOT_FOUND");
        if (item.delivery === "steer" && (
          item.targetTurnId !== body.expectedTurnId || item.targetRunAttemptId !== body.expectedRunAttemptId
        )) {
          return jsonResponse(request, env, ThreadInputReceiptSchema.parse({
            status: "conflict", code: "target_superseded", message: "This input is already bound to a different turn attempt.",
          }), { status: 409 });
        }
        if (item.delivery === "steer" && (item.receipt?.status === "accepted" || item.receipt?.status === "applied" || item.receipt?.status === "unconfirmed")) {
          return jsonResponse(request, env, item.receipt);
        }
        const admission = await withTurnAdmissionRepository(env, (repository) => repository.getByTurnId(body.expectedTurnId));
        if (
          !admission || admission.state !== "admitted" || admission.userId !== user.userId ||
          admission.sessionId !== scope.sessionId || admission.threadId !== body.threadId ||
          admission.workspaceId !== body.workspaceId || admission.runAttemptId !== body.expectedRunAttemptId
        ) {
          return errorResponse(request, env, "The selected turn is no longer active.", 409, "TURN_NOT_ACTIVE");
        }
        const runtimeScope = await resolveExecutionScope(request, env, admission.runId, correlationId);
        if (runtimeScope.userId !== user.userId || runtimeScope.workspaceId !== body.workspaceId) {
          return errorResponse(request, env, "The selected turn scope has changed.", 409, "TARGET_SUPERSEDED");
        }
        if (item.mediaRefs.length > 0) {
          const run = await withRunRepository(env, (repository) => repository.getRun(admission.runId, user.userId));
          const modelMetadata = await resolveChatModelMetadata({
            providerId: run?.providerId ?? undefined,
            modelId: run?.modelId ?? undefined,
            fetchModels: (providerId, query) => fetchRunProviderModels(env, {
              runId: admission.runId,
              userId: user.userId,
              workspaceId: body.workspaceId,
              providerId,
              query,
              requestedBackend: "execution-engine-v1",
            }),
          });
          assertChatImageModelSupport(modelMetadata);
        }
        let expectedReceiptVersion = item.version;
        if (item.delivery === "queue") {
          const claimed = await withThreadInputRepository(env, (repository) => repository.claimForSteering({
            ...scope,
            itemId,
            expectedVersion: body.expectedVersion,
            targetTurnId: body.expectedTurnId,
            targetRunAttemptId: body.expectedRunAttemptId,
          }));
          if (claimed.status === "conflict") {
            return jsonResponse(request, env, ThreadInputReceiptSchema.parse({
              status: "conflict", code: claimed.code, message: "Queue item changed or was already consumed.",
            }), { status: 409 });
          }
          expectedReceiptVersion = claimed.item.version;
        }
        const transcriptMessageId = `thread-input:${item.itemId}`;
        const runtimeResponse = await fetchRunRuntimeRoute(env, admission.runId, "execution-engine-v1", {
          method: "POST",
          path: "/thread/inputs/steer",
          body: JSON.stringify({
            sessionId: scope.sessionId,
            userId: user.userId,
            runId: admission.runId,
            workspaceId: body.workspaceId,
            threadId: body.threadId,
            turnId: body.expectedTurnId,
            runAttemptId: body.expectedRunAttemptId,
            inputId: item.itemId,
            clientInputId: item.clientInputId,
            transcriptMessageId,
            text: item.text,
            mediaRefs: item.mediaRefs,
          }),
          headers: { "Content-Type": "application/json" },
        });
        const runtimeBody = await runtimeResponse.json().catch(() => null) as Record<string, unknown> | null;
        if (!runtimeResponse.ok) {
          if (runtimeResponse.status >= 500 || runtimeResponse.status !== 409 ||
            (runtimeBody?.code !== "turn_not_active" && runtimeBody?.code !== "target_superseded")) {
            return errorResponse(request, env, "Steering outcome is being reconciled. Retry from the current queue snapshot.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
          }
          const code = runtimeBody?.code === "target_superseded" ? "target_superseded" : "turn_not_active";
          const conflict = ThreadInputReceiptSchema.parse({
            status: "conflict",
            code,
            message: typeof runtimeBody?.error === "string" ? runtimeBody.error : "The selected turn no longer accepts input.",
          });
          await withThreadInputRepository(env, (repository) => repository.recordReceipt({
            ...scope,
            itemId,
            expectedVersion: expectedReceiptVersion,
            receipt: conflict,
            state: "cancelled",
          }));
          return jsonResponse(request, env, conflict, { status: 409 });
        }
        const receipt = ThreadInputReceiptSchema.parse({
          status: "accepted",
          clientInputId: item.clientInputId,
          inputId: item.itemId,
          targetTurnId: body.expectedTurnId,
          targetRunAttemptId: body.expectedRunAttemptId,
          acceptedSequence: Number(runtimeBody?.acceptedSequence),
        });
        const authoritative = await withThreadInputRepository(env, (repository) => repository.getById({ ...scope, itemId }));
        const authoritativeReceipt = authoritative?.receipt;
        if (!authoritativeReceipt) {
          return errorResponse(request, env, "Steering outcome is being reconciled. Retry from the current queue snapshot.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
        }
        if (authoritativeReceipt.status === "unconfirmed") return jsonResponse(request, env, authoritativeReceipt);
        if (authoritativeReceipt.status === "accepted" || authoritativeReceipt.status === "applied") {
          if (authoritativeReceipt.acceptedSequence !== Number(runtimeBody?.acceptedSequence)) {
            return errorResponse(request, env, "Steering outcome is being reconciled. Retry from the current queue snapshot.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
          }
        } else {
          return errorResponse(request, env, "Steering outcome is being reconciled. Retry from the current queue snapshot.", 503, "THREAD_INPUT_OUTCOME_UNKNOWN");
        }
        return jsonResponse(request, env, authoritativeReceipt, { status: 202 });
      }
      if (operation) return errorResponse(request, env, "Method Not Allowed", 405);

      if (request.method === "PATCH") {
        const body = validateWithSchema<z.infer<typeof UpdateThreadInputCommandSchema>>(
          await parseRequestBody(request, correlationId),
          UpdateThreadInputCommandSchema,
          correlationId,
        );
        if (body.itemId !== itemId) return errorResponse(request, env, "Queue item path does not match request body", 400, "QUEUE_ITEM_PATH_MISMATCH");
        const scope = await resolveThreadScope(env, user.userId, body);
        const current = await withThreadInputRepository(env, (repository) => repository.list(scope));
        const existing = current.items.find((item) => item.itemId === itemId);
        if (!existing) return errorResponse(request, env, "Queue item not found", 404, "QUEUE_ITEM_NOT_FOUND");
        const effectiveImages = body.content.images ?? existing.mediaRefs;
        if (!body.content.text.trim() && effectiveImages.length === 0) {
          return errorResponse(request, env, "Provide text or at least one image.", 400, "THREAD_INPUT_CONTENT_INVALID");
        }
        const mediaRefs = body.content.images
          ? await persistImages(env, user.userId, scope.sessionId, `${itemId}_${body.expectedVersion + 1}`, body.content.images)
          : undefined;
        const result = await withThreadInputRepository(env, (repository) => repository.update({
          ...scope,
          itemId,
          expectedVersion: body.expectedVersion,
          text: body.content.text,
          ...(mediaRefs ? { mediaRefs } : {}),
          ...(body.configuration ? { configuration: body.configuration } : {}),
        }));
        return mutationResponse(request, env, result);
      }

      if (request.method === "DELETE") {
        const body = validateWithSchema<z.infer<typeof RemoveThreadInputCommandSchema>>(
          await parseRequestBody(request, correlationId),
          RemoveThreadInputCommandSchema,
          correlationId,
        );
        if (body.itemId !== itemId) return errorResponse(request, env, "Queue item path does not match request body", 400, "QUEUE_ITEM_PATH_MISMATCH");
        const scope = await resolveThreadScope(env, user.userId, body);
        const result = await withThreadInputRepository(env, (repository) => repository.remove({ ...scope, itemId, expectedVersion: body.expectedVersion }));
        return mutationResponse(request, env, result);
      }
      return errorResponse(request, env, "Method Not Allowed", 405);
    } catch (error: unknown) {
      if (error instanceof ResumeTurnError) {
        if (error.status === 409) {
          const code = error.code.includes("snapshot")
            ? "workspace_snapshot_unavailable"
            : "target_superseded";
          return jsonResponse(request, env, ResumeTurnReceiptSchema.parse({
            status: "conflict", code, message: error.message,
          }), { status: 409 });
        }
        return errorResponse(request, env, error.message, error.status, error.code.toUpperCase());
      }
      if (isDomainError(error)) {
        const mapped = mapDomainErrorToHttp(error);
        return errorResponse(request, env, mapped.message, mapped.status, mapped.code, mapped.metadata);
      }
      if (error instanceof ThreadInputConflictError) {
        if (error.code === "queue_item_changed" || error.code === "queue_item_consumed") {
          return jsonResponse(request, env, { status: "conflict", code: error.code, message: error.message }, { status: 409 });
        }
        return errorResponse(request, env, error.message, 409, error.code.toUpperCase());
      }
      return errorResponse(request, env, "Thread input operation failed", 500, "THREAD_INPUT_FAILED");
    }
  }
}

async function resolveThreadScope(env: Env, userId: string, identity: { threadId: string; workspaceId: string }) {
  const threadId = ThreadIdSchema.parse(identity.threadId);
  const workspaceId = WorkspaceScopeIdSchema.parse(identity.workspaceId);
  const session = await withTranscriptRepository(env, async (repository) => {
    const result = await repository.listSessions(userId);
    return result.sessions.find((candidate) => candidate.threadId === threadId) ?? null;
  });
  if (!session || session.workspaceId !== workspaceId) {
    throw new ThreadInputConflictError("Conversation thread or workspace scope does not match", "thread_scope_conflict");
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
    // Bind media identity to the exact submitted bytes before writing R2. A
    // replay with the same client input is idempotent; changed bytes cannot
    // overwrite the image already referenced by a pending or consumed row.
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

function mutationResponse(request: Request, env: Env, result: Awaited<ReturnType<import("@repo/persistence").ThreadInputRepository["remove"]>>): Response {
  if (result.status === "conflict") {
    return jsonResponse(request, env, ThreadInputReceiptSchema.parse({
      status: "conflict",
      code: result.code,
      message: "Queue item changed or was already consumed.",
    }));
  }
  return jsonResponse(request, env, result.item.receipt ?? {
    status: "pending",
    clientInputId: result.item.clientInputId,
    itemId: result.item.itemId,
    order: result.item.order,
    version: result.item.version,
    revision: result.revision,
  });
}
