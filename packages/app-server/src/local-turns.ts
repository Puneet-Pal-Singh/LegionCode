import type { BYOKDiscoveredProviderModel } from "@repo/shared-types";
import {
  ModelIdSchema,
  ContentDigestSchema,
  LocalTurnConfigurationSchema,
  LocalTurnConfigurationOptionsSchema,
  type LocalTurnConfiguration,
  type LocalTurnConfigurationOptions,
} from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import { EventStoreError } from "@repo/event-store/errors";
import type {
  TurnAdmission,
  Thread,
  ProviderId,
  ModelId,
  LocalWorkspaceGrant,
  TurnId,
  LifecycleEvent,
  SubmitLifecycleApprovalRequest,
  ReplayLifecycleEventsRequest,
} from "@repo/platform-protocol";
import type {
  LocalTurnStartParams,
  LocalThreadHistoryParams,
  LocalTurnInterruptParams,
} from "./protocol.js";
import { LocalTurnStartParamsSchema } from "./protocol.js";
import type {
  LocalWorkspaceService,
  LocalWorkspaceExecutionBinding,
} from "./local-workspace.js";
import type { LocalThreadService } from "./local-threads.js";
import type { LocalProviderService, ProviderSelection } from "./local-providers.js";
import { AppServerOperationError } from "./server.js";
import { LocalApprovalService } from "./local-approvals.js";
import type { LocalTurnMediaPort, LocalTurnPreparedMedia } from "./local-turn-media.js";
import { localTurnImageReferences } from "./local-turn-images.js";
import { captureLocalTurnModel } from "./local-turn-model.js";
import { LocalTurnResources, type LocalTurnPreparation } from "./local-turn-resources.js";
import {
  LocalInterruptionService,
  LocalInterruptionAttemptNotActiveError,
} from "./local-interruption.js";

/** Runtime objects and ports only; this host never produces lifecycle events. */
export type LocalTurnExecutor = {
  execute(admission: TurnAdmission): Promise<unknown>;
  /** True only after physical quiescence and canonical terminal/capture settlement. */
  awaitResourceRelease(turnId: TurnId): Promise<boolean>;
  interrupt(turnId: TurnId, reason: string): Promise<void>;
  resolveApproval: ConstructorParameters<
    typeof LocalApprovalService
  >[0]["resolveApproval"];
};
export type LocalTurnServiceOptions = {
  persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents">;
  workspaces: LocalWorkspaceService;
  threads: LocalThreadService;
  providers: LocalProviderService;
  media?: LocalTurnMediaPort;
  runtime?: {
    readonly configurationOptions: LocalTurnConfigurationOptions;
    /** Startup-only reconciliation before new commands can acquire ownership. */
    reconcileLostTurn(admission: TurnAdmission): Promise<"settled" | "already_terminal" | "unsupported">;
    createAdmission(input: {
      workspace: LocalWorkspaceGrant;
      thread: Thread;
      prompt: string;
      clientRequestId: string;
      providerId: ProviderId;
      modelId: ModelId;
      configuration: LocalTurnConfiguration;
      media?: { preparation: LocalTurnPreparedMedia; imageCount: number };
    }): Promise<TurnAdmission>;
    createExecutor(binding: LocalWorkspaceExecutionBinding, admission: TurnAdmission, model: BYOKDiscoveredProviderModel): LocalTurnExecutor;
  };
};

export type LocalTurnRuntime = NonNullable<LocalTurnServiceOptions["runtime"]>;

export class LocalTurnService {
  private readonly resources: LocalTurnResources;
  private readonly approvals: LocalApprovalService;
  private readonly interruption: LocalInterruptionService;

  constructor(private readonly options: LocalTurnServiceOptions) {
    this.approvals = new LocalApprovalService({
      lifecycleEvents: options.persistence.lifecycleEvents,
      threads: options.threads,
      resolveApproval: (turnId, approvalId, resolution) =>
        this.requireExecutor(turnId).resolveApproval(
          turnId,
          approvalId,
          resolution,
        ),
    });
    this.interruption = new LocalInterruptionService({
      turnAdmissions: options.persistence.turnAdmissions,
      lifecycleEvents: options.persistence.lifecycleEvents,
      executor: {
        interrupt: (turnId, reason) =>
          this.requireExecutor(turnId).interrupt(turnId, reason),
      },
    });
    this.resources = new LocalTurnResources({
      hasUnsettledWorkspaceResources: () => options.workspaces.hasUnsettledResources,
      interrupt: async (admission) => {
        await this.interruption.interruptTurn({
          workspaceId: admission.run.workspaceId,
          threadId: admission.run.threadId,
          runId: admission.run.id,
          turnId: admission.turn.id,
          runAttemptId: admission.runAttemptId,
          reason: "Local runtime is shutting down",
        });
      },
    });
  }

  get hasActiveExecutions(): boolean { return this.resources.hasActiveExecutions; }

  shutdown(): Promise<void> { return this.resources.shutdown(); }

  getConfigurationOptions(): LocalTurnConfigurationOptions {
    return LocalTurnConfigurationOptionsSchema.parse(this.options.runtime?.configurationOptions);
  }

  async startTurn(input: LocalTurnStartParams): Promise<TurnAdmission> {
    const params = LocalTurnStartParamsSchema.parse(input);
    return this.resources.prepare((preparation) => this.startPreparedTurn(params, preparation));
  }

  private async startPreparedTurn(params: LocalTurnStartParams, preparation: LocalTurnPreparation): Promise<TurnAdmission> {
    const images = params.images ?? [];
    const thread = await this.options.threads.get(params.threadId);
    if (thread.workspaceId !== params.workspaceId) {
      throw new AppServerOperationError(
        404,
        "not_found",
        "Local thread was not found in the granted workspace",
      );
    }
    const previous =
      await this.options.persistence.turnAdmissions.findByRequest(
        thread.id,
        params.clientRequestId,
      );
    if (previous) {
      // A receipt retry does not create records, acquire execution authority or resolve credentials.
      const imageFingerprint = await this.submittedImageFingerprint(images);
      const currentThread = await this.options.threads.get(thread.id);
      return validateSavedAdmission(previous, params, currentThread, imageFingerprint);
    }
    if (thread.status !== "active") {
      throw new AppServerOperationError(
        409,
        "conflict",
        "The local thread is not active in this workspace",
      );
    }
    const runtime = this.options.runtime;
    if (!runtime)
      throw new AppServerOperationError(
        503,
        "server_unavailable",
        "Local turn execution is not configured",
      );
    const configuration = LocalTurnConfigurationSchema.parse({
      mode: params.mode,
      productMode: params.productMode,
    });
    const productModes = runtime.configurationOptions.productModesByMode?.[configuration.mode]
      ?? runtime.configurationOptions.productModes;
    if (!runtime.configurationOptions.modes.includes(configuration.mode) ||
        !productModes.includes(configuration.productMode)) {
      throw new AppServerOperationError(503, "server_unavailable", "The selected local execution mode is unavailable");
    }
    let preparedMedia: LocalTurnPreparedMedia | undefined;
    try {
      this.resources.assertAcceptingAdmission();
      const binding = await this.options.workspaces.bindForExecution(
        params.workspaceId,
      );
      preparation.binding = binding;
      this.resources.assertAcceptingAdmission();
      const selection = await this.options.providers.getSelection();
      if (!selection)
        throw new AppServerOperationError(
          409,
          "conflict",
          "Select a protected provider and model before starting a turn",
        );
      assertProviderSelection(selection, params.expectedSelection);
      const model = captureLocalTurnModel(
        await this.options.providers.getModel(selection.providerId, selection.modelId),
        selection,
      );
      const hasImages = images.length > 0 || await this.hasImageHistory(thread.id);
      if (hasImages && model.capabilities?.supportsVision !== true) {
        throw new AppServerOperationError(409, "conflict", "The selected model does not support image input", "local_image_model_unsupported", false);
      }
      preparedMedia = await this.prepareImages(images, AbortSignal.any([binding.signal, this.resources.admissionSignal]));
      binding.assertCurrent();
      this.resources.assertAcceptingAdmission();
      let candidate: TurnAdmission;
      try {
        candidate = await runtime.createAdmission({
          workspace: binding.workspace,
          thread,
          prompt: params.prompt,
          clientRequestId: params.clientRequestId,
          providerId: selection.providerId,
          modelId: ModelIdSchema.parse(selection.modelId),
          configuration,
          ...(preparedMedia ? { media: { preparation: preparedMedia, imageCount: images.length } } : {}),
        });
      } catch (error) {
        if (!preparedMedia) throw error;
        // Candidate preparation has not called the sole atomic admission owner.
        throw new AppServerOperationError(503, "server_unavailable", "Image attachments are unavailable", "local_image_unavailable", false);
      }
      this.resources.assertAcceptingAdmission();
      // Construct ports before admission; providers execute only through execute().
      const executor = runtime.createExecutor(binding, candidate, model);
      if (typeof executor.awaitResourceRelease !== "function") {
        throw new AppServerOperationError(
          503,
          "server_unavailable",
          "Local execution requires runtime resource-settlement confirmation",
        );
      }
      binding.assertCurrent();
      assertProviderSelection(await this.options.providers.getSelection(), selection);
      binding.assertCurrent();
      this.resources.assertAcceptingAdmission();
      const { admission, newlyAdmitted } =
        await this.options.persistence.turnAdmissions.admit(candidate);
      if (newlyAdmitted) this.resources.ownExecution(preparation, admission, executor);
      return admission;
    } catch (error) {
      // Another identical request can commit while this request prepares its
      // binding/provider or loses the repository's stricter fingerprint race.
      const saved = await this.options.persistence.turnAdmissions.findByRequest(
        thread.id,
        params.clientRequestId,
      );
      if (saved) {
        // A concurrent winner can commit before this request reaches image
        // preparation. Derive only the submitted content identity for its receipt.
        const imageFingerprint = preparedMedia?.fingerprint
          ?? await this.submittedImageFingerprint(images);
        const currentThread = await this.options.threads.get(thread.id);
        if (currentThread.workspaceId !== params.workspaceId) {
          throw new AppServerOperationError(
            404,
            "not_found",
            "Local thread was not found in the granted workspace",
          );
        }
        return validateSavedAdmission(saved, params, currentThread, imageFingerprint);
      }
      if (error instanceof EventStoreError && error.code === "idempotency_conflict") {
        throw new AppServerOperationError(409, "conflict", "Local Turn admission conflicts with its current thread state or request content", "local_admission_conflict", false);
      }
      throw error;
    } finally {
      if (preparedMedia) {
        try {
          // The synchronous SQLite admission attempt above has settled. Only a
          // fresh exact-scope absence permits cleanup; unknown outcomes retain.
          await preparedMedia.discardUnadmitted(async (scope) =>
            await this.options.persistence.turnAdmissions.getByTurn(scope.turnId) === null,
          );
        } catch {
          console.error("Local image resources retained pending canonical admission reconciliation");
        }
      }
      await this.resources.closePreparation(preparation);
    }
  }

  private async submittedImageFingerprint(images: LocalTurnStartParams["images"]): Promise<string | undefined> {
    try {
      return (await this.prepareImages(images, this.resources.admissionSignal))?.fingerprint;
    } catch {
      throw new AppServerOperationError(409, "conflict", "Admission request key has different image content");
    }
  }

  private async prepareImages(images: LocalTurnStartParams["images"], signal?: AbortSignal): Promise<LocalTurnPreparedMedia | undefined> {
    if (!images?.length) return undefined;
    if (!this.options.media) {
      throw new AppServerOperationError(503, "server_unavailable", "Local image input is unavailable", "local_image_unavailable", false);
    }
    try {
      const prepared = await this.options.media.prepare(images, signal);
      ContentDigestSchema.parse(prepared.fingerprint);
      return prepared;
    } catch {
      signal?.throwIfAborted();
      throw new AppServerOperationError(400, "invalid_request", "Image attachments could not be validated", "local_image_validation_failed", false);
    }
  }

  private async hasImageHistory(threadId: Thread["id"]): Promise<boolean> {
    let afterCursor: LocalThreadHistoryParams["afterCursor"] = null;
    do {
      this.resources.assertAcceptingAdmission();
      const page = await this.options.persistence.turnAdmissions.listByThread({ threadId, afterCursor, limit: 100 });
      if (page.admissions.some((admission) => localTurnImageReferences(admission).length > 0)) return true;
      afterCursor = page.nextCursor;
    } while (afterCursor !== null);
    return false;
  }

  async getTurn(turnId: TurnId): Promise<TurnAdmission> {
    const admission =
      await this.options.persistence.turnAdmissions.getByTurn(turnId);
    if (!admission)
      throw new AppServerOperationError(
        404,
        "not_found",
        "Local turn was not found",
      );
    const thread = await this.options.threads.get(admission.run.threadId);
    if (thread.workspaceId !== admission.run.workspaceId) {
      throw new AppServerOperationError(
        404,
        "not_found",
        "Local turn was not found in the granted workspace",
      );
    }
    return admission;
  }

  async readHistory(params: LocalThreadHistoryParams) {
    const thread = await this.options.threads.get(params.threadId);
    if (thread.workspaceId !== params.workspaceId) {
      throw new AppServerOperationError(
        404,
        "not_found",
        "Local thread was not found in the granted workspace",
      );
    }
    const page = await this.options.persistence.turnAdmissions.listByThread({
      threadId: thread.id,
      afterCursor: params.afterCursor ?? null,
      limit: params.limit ?? (params.latest ? 25 : 50),
      latest: params.latest,
    }).catch((error: unknown) => {
      if (error instanceof EventStoreError && error.code === "history_row_too_large") {
        throw new AppServerOperationError(503, "server_unavailable", "The next history Turn exceeds the supported response size", "history_row_too_large", false);
      }
      throw error;
    });
    const current = await this.options.threads.get(thread.id);
    if (current.workspaceId !== params.workspaceId) {
      throw new AppServerOperationError(404, "not_found", "Local thread was not found in the granted workspace");
    }
    return {
      admissions: [...page.admissions], nextCursor: page.nextCursor,
      ...(params.latest ? { hasEarlier: page.hasEarlier } : {}),
    };
  }

  async replayLifecycleEvents(params: ReplayLifecycleEventsRequest) {
    if (params.backend !== undefined)
      throw new AppServerOperationError(
        400,
        "invalid_request",
        "Local replay does not accept a hosted backend",
      );
    await this.getTurn(params.turnId);
    const page = await this.options.persistence.lifecycleEvents.replay({
      turnId: params.turnId,
      afterSequence: params.afterSequence ?? null,
      limit: params.limit ?? 1_000,
    });
    await this.getTurn(params.turnId);
    return page;
  }

  async interruptTurn(params: LocalTurnInterruptParams) {
    await this.getTurn(params.turnId);
    try {
      return await this.interruption.interruptTurn(params);
    } catch (error) {
      if (error instanceof LocalInterruptionAttemptNotActiveError) {
        throw new AppServerOperationError(409, "conflict", error.message);
      }
      throw error;
    }
  }

  submitLifecycleApproval(
    params: SubmitLifecycleApprovalRequest,
  ): Promise<LifecycleEvent> {
    return this.approvals.submitLifecycleApproval(params);
  }

  private requireExecutor(turnId: TurnId): LocalTurnExecutor {
    const executor = this.resources.getExecutor(turnId);
    if (!executor) throw new LocalInterruptionAttemptNotActiveError();
    return executor;
  }
}

function validateSavedAdmission(
  admission: TurnAdmission,
  params: LocalTurnStartParams,
  thread: Thread,
  imageFingerprint?: string,
): TurnAdmission {
  const configuration = LocalTurnConfigurationSchema.parse({ mode: params.mode, productMode: params.productMode });
  const saved = admission.userMessage.type === "user_message"
    ? admission.userMessage.content.configuration
    : undefined;
  const savedConfiguration = saved === undefined ? undefined : LocalTurnConfigurationSchema.parse(saved);
  if (
    admission.run.workspaceId !== params.workspaceId ||
    admission.run.userId !== thread.userId ||
    admission.userMessage.type !== "user_message" ||
    admission.userMessage.content.text !== params.prompt ||
    admission.userMessage.content.imageFingerprint !== imageFingerprint ||
    (params.expectedSelection !== undefined && (
      admission.run.providerId !== params.expectedSelection.providerId ||
      admission.run.modelId !== params.expectedSelection.modelId
    )) ||
    (savedConfiguration
      ? savedConfiguration.mode !== configuration.mode || savedConfiguration.productMode !== configuration.productMode
      : params.mode !== undefined || params.productMode !== undefined)
  ) {
    throw new AppServerOperationError(
      409,
      "conflict",
      "Admission request key has different content or ownership",
    );
  }
  return admission;
}

function assertProviderSelection(
  selection: ProviderSelection | null,
  expected: Pick<ProviderSelection, "providerId" | "modelId"> | undefined,
): void {
  if (expected && (!selection || selection.providerId !== expected.providerId || selection.modelId !== expected.modelId)) {
    throw new AppServerOperationError(
      409,
      "conflict",
      "The selected provider or model changed before this message was admitted",
      "local_provider_selection_changed",
      false,
    );
  }
}
