import {
  ContentDigestSchema, ThreadInputReceiptSchema, ThreadIdSchema,
  type ChatImageAttachmentRef, type TurnAdmission,
} from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import { ThreadInputConflictError, type StoredThreadInput, type ThreadInputScope } from "@repo/event-store";
import { RuntimeKernelError } from "@repo/runtime-kernel";
import type { LocalThreadService } from "./local-threads.js";
import type { LocalProviderService } from "./local-providers.js";
import type { LocalTurnService } from "./local-turns.js";
import { LocalQueuedInputMediaOwnershipSchema, type LocalQueuedInputMediaPort, type LocalQueuedInputMediaScope } from "./local-queued-input-media.js";
import { AppServerMethodOutcome, AppServerOperationError } from "./server.js";
import { readLocalTurnArtifactPublication } from "./local-turn-artifact-publication.js";
import { LocalInterruptionAttemptNotActiveError } from "./local-interruption.js";
import { ThreadInputCommandService, ThreadInputCommandError } from "./thread-inputs/ThreadInputCommandService.js";
import type { PreparedThreadInputMedia } from "./thread-inputs/ports.js";

/** Native placement adapter only. The actual held-successor admission owner is
 * required; no default can turn terminal history or absent maps into closure. */
export function createLocalThreadInputOperations(options: {
  persistence: Pick<LocalPersistence, "threadInputs" | "lifecycleEvents">;
  threads: LocalThreadService;
  turns: Pick<LocalTurnService, "getTurn" | "acceptQueuedSteer">;
  providers: Pick<LocalProviderService, "getModel">;
  media: LocalQueuedInputMediaPort;
  startQueuedTurn: LocalTurnService["startQueuedTurn"];
}) {
  const repository = options.persistence.threadInputs;
  const authorize = async (identity: { threadId: string; workspaceId: string }): Promise<ThreadInputScope> => {
    const thread = await options.threads.get(ThreadIdSchema.parse(identity.threadId));
    if (thread.workspaceId !== identity.workspaceId)
      throw new AppServerOperationError(404, "not_found", "Local thread was not found in the granted workspace");
    return { sessionId: thread.id, threadId: thread.id, userId: thread.userId, workspaceId: thread.workspaceId };
  };
  const service = new ThreadInputCommandService({
    repository, authorize,
    validateConfiguration: (configuration) => {
      if (Object.keys(configuration).length)
        throw new AppServerOperationError(400, "invalid_request", "Native queued inputs use the current workspace configuration; send an empty configuration", "local_input_configuration_unsupported", false);
    },
    prepareMedia: async ({ scope, inputId, mediaRevision, images }): Promise<PreparedThreadInputMedia> => {
      if (!images.length) return { references: [], fingerprint: null, mediaRevision: null, discardUnpublished: async () => undefined };
      const token = await options.media.prepareQueued(images);
      const mediaScope = { userId: scope.userId, workspaceId: scope.workspaceId, threadId: scope.threadId, inputId, mediaRevision };
      let references: readonly ChatImageAttachmentRef[];
      try { references = await token.persist(mediaScope); }
      catch (error) {
        await token.discardUnadmitted(async (requested) => {
          const item = await repository.readForMedia({ ...scope, itemId: requested.inputId });
          return item === null || item.mediaRevision !== requested.mediaRevision;
        });
        throw error;
      }
      return { references, fingerprint: token.fingerprint, mediaRevision,
        discardUnpublished: async () => {
          await token.discardUnadmitted(async (requested) => {
            const item = await repository.readForMedia({ ...scope, itemId: requested.inputId });
            return item === null || item.mediaRevision !== requested.mediaRevision;
          });
        } };
    },
    assertSteeringTarget: async (scope, target, hasImages) => {
      const admission = await options.turns.getTurn(target.expectedTurnId);
      if (!sameTarget(scope, admission, target.expectedRunAttemptId) ||
          (await repository.list(scope)).activeRunId !== admission.run.id)
        return { status: "conflict", code: "target_superseded", message: "The selected turn is no longer active." };
      if (hasImages) {
        if (!admission.run.providerId || !admission.run.modelId ||
            (await options.providers.getModel(admission.run.providerId, admission.run.modelId))?.capabilities?.supportsVision !== true)
          throw new AppServerOperationError(409, "conflict", "The selected model does not support image input", "local_image_model_unsupported", false);
      }
    },
    deliverSteer: async (scope, item) => {
      const parts = item.mediaRefs.length ? await options.media.resolveQueuedForProvider(mediaRead(item)) : [];
      await authorize(scope);
      try {
        const acceptedSequence = await options.turns.acceptQueuedSteer({ scope, item,
          message: { role: "user", content: parts.length ? [{ type: "text", text: item.text }, ...parts] : item.text } });
        return { acceptedSequence };
      } catch (error) {
        // Only these pre-effect exact-attempt failures are known denial. Any
        // append/ACK/provider ambiguity remains owned by shared receipt reread.
        if ((error instanceof RuntimeKernelError && error.code === "turn_not_active") || error instanceof LocalInterruptionAttemptNotActiveError)
          return { status: "conflict", code: "turn_not_active", message: "The selected turn no longer accepts input." };
        throw error;
      }
    },
    startQueued: async ({ scope, command, explicitStart }) => {
      const item = await repository.getById({ ...scope, itemId: command.itemId });
      if (!item) return { status: "conflict", code: "queue_item_changed", message: "Queue item was not found." };
      if (item.receipt?.status === "started") return item.receipt;
      if (item.delivery !== "queue" || item.state !== "pending" || item.version !== command.expectedVersion)
        return { status: "conflict", code: "queue_item_changed", message: "Queue item changed or was already consumed." };
      // Existing rows imported from another placement cannot silently select a
      // different Native provider, model, mode or sandbox.
      if (Object.keys(item.configuration).length)
        throw new AppServerOperationError(400, "invalid_request", "Native queued input configuration is unsupported", "local_input_configuration_unsupported", false);
      try {
        const admission = await options.startQueuedTurn({ scope, item, command, explicitStart,
          prepareMedia: async (signal) => item.mediaRefs.length ? options.media.promoteQueued({ ...mediaRead(item), signal }) : undefined });
        const saved = await repository.getById({ ...scope, itemId: item.itemId });
        if (saved?.receipt?.status !== "started" || saved.receipt.turnId !== admission.turn.id ||
            saved.receipt.runAttemptId !== admission.runAttemptId || saved.receipt.runId !== admission.run.id)
          throw new AppServerOperationError(503, "server_unavailable", "Queued admission requires reconciliation", "THREAD_INPUT_OUTCOME_UNKNOWN", false);
        return saved.receipt;
      } catch (error) {
        if (error instanceof ThreadInputConflictError && ["queue_item_changed", "queue_revision_conflict", "queue_paused", "thread_not_idle"].includes(error.code))
          return ThreadInputReceiptSchema.parse({ status: "conflict", code: error.code, message: error.message });
        // Preserve actual intent and require explicit reconciliation. This also
        // covers a committed admission whose acknowledgement was interrupted.
        await repository.setPaused({ ...scope, paused: true, reason: "Queued admission or predecessor resource settlement requires reconciliation." });
        throw error;
      }
    },
  });
  return {
    execute: async (command: Parameters<ThreadInputCommandService["execute"]>[0]) => {
      try { const result = await service.execute(command); return new AppServerMethodOutcome(result.statusCode, result.result); }
      catch (error) {
        if (error instanceof ThreadInputCommandError)
          throw new AppServerOperationError(error.statusCode, error.statusCode === 400 ? "invalid_request" : error.statusCode === 404 ? "not_found" : "server_unavailable", error.message, error.operationCode, false);
        if (error instanceof ThreadInputConflictError)
          throw new AppServerOperationError(409, "conflict", error.message, error.code, false);
        throw error;
      }
    },
    onResourcesReleased: async (admission: TurnAdmission) => {
      const scope = await authorize({ threadId: admission.run.threadId, workspaceId: admission.run.workspaceId });
      const current = await repository.list(scope);
      if (current.paused) return;
      const publication = await readLocalTurnArtifactPublication(options.persistence.lifecycleEvents, admission);
      if (!publication.terminal || publication.terminal.type !== "turn.completed") return;
      // The callback comes only from the original positive receipt owner. The
      // next start still verifies the predecessor under its held successor lease.
      await service.onTurnTerminal({ ...scope, type: publication.terminal.type });
    },
  };
}

function sameTarget(scope: ThreadInputScope, admission: TurnAdmission, runAttemptId: string): boolean {
  return admission.run.userId === scope.userId && admission.run.workspaceId === scope.workspaceId &&
    admission.run.threadId === scope.threadId && admission.runAttemptId === runAttemptId;
}
function mediaRead(item: StoredThreadInput) {
  if (!item.mediaRevision || !item.mediaFingerprint) throw new AppServerOperationError(503, "server_unavailable", "Queued image ownership is unavailable", "local_image_unavailable", false);
  const scope: LocalQueuedInputMediaScope = { userId: item.userId, workspaceId: item.workspaceId, threadId: item.threadId,
    inputId: item.itemId, mediaRevision: item.mediaRevision };
  return { scope, fingerprint: ContentDigestSchema.parse(item.mediaFingerprint), references: item.mediaRefs };
}

/** Same canonical row owner for startup journal reconciliation and all byte reads. */
export async function readQueuedInputMediaOwnership(persistence: Pick<LocalPersistence, "threadInputs">,
  scope: LocalQueuedInputMediaScope) {
  const item = await persistence.threadInputs.readForMedia({ sessionId: scope.threadId, threadId: scope.threadId,
    userId: scope.userId, workspaceId: scope.workspaceId, itemId: scope.inputId });
  if (!item || item.mediaRevision !== scope.mediaRevision) return null;
  return LocalQueuedInputMediaOwnershipSchema.parse({ scope, fingerprint: item.mediaFingerprint, references: item.mediaRefs });
}
