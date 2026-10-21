import type { RunRecord } from "@repo/persistence";
import type {
  ResumeWorkspaceSnapshotRef,
  TurnScopeBootstrap,
} from "@repo/platform-protocol";
import {
  workspaceIdFromExternalId,
  type ProtocolError,
} from "@repo/platform-protocol";
import { HandleChatRequest } from "../../application/chat/HandleChatRequest";
import type { Env } from "../../types/ai";
import {
  executeViaRunEngineDurableObject,
  fetchRunProviderModels,
  fetchRunRuntimeRoute,
} from "../../controllers/chat-runtime-helpers";
import { mapAgentIdToType } from "../../controllers/chat-request-helpers";
import { resolveChatModelMetadata } from "../chat/ChatModelMetadataResolution";
import { validateChatReasoningEffort } from "../chat/ChatReasoningEffortPolicy";
import type { ChatModelMetadata } from "../chat/ChatModelMetadataResolver";
import { withTurnAdmissionRepository } from "../turn-admissions/TurnAdmissionPersistenceFactory";
import { BrainLifecycleEventStore } from "../lifecycle/BrainLifecycleEventStore";
import { settleOwnedStartupFailure } from "../../runtime/RuntimeLifecycleSettlement";
import { sanitizeUnknownError } from "../../core/security/LogSanitizer";
import { ExecuteRunPayloadSchema } from "../../runtime/parsing/ExecuteRunPayloadSchema";
import { toRuntimeRunMode } from "../chat/RuntimeRunMode";
import type { AuthorizedWorkspaceRepositoryContext } from "../workspaces/AuthorizedWorkspaceRepositoryContext";

export interface AdmittedTurnExecution {
  readonly request: Request;
  readonly env: Env;
  readonly executionContext?: ExecutionContext;
  readonly sessionId: string;
  readonly run: RunRecord;
  readonly userId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly identity: TurnScopeBootstrap;
  readonly prompt: string;
  readonly promptMessageId: string;
  readonly configuration: {
    readonly mode?: string;
    readonly providerId?: string | null;
    readonly modelId?: string | null;
    readonly reasoningEffort?: import("@repo/shared-types").ReasoningEffort;
    readonly productMode?: import("@repo/shared-types").ProductMode;
    readonly harnessId?: "cloudflare-sandbox" | "local-sandbox";
  };
  readonly modelMetadata?: ChatModelMetadata;
  readonly resumeSnapshotRef?: ResumeWorkspaceSnapshotRef;
  readonly repository: AuthorizedWorkspaceRepositoryContext | null;
  readonly onStartupFailure: (error: unknown) => Promise<boolean>;
  readonly onDispatchSettled: () => Promise<void>;
  readonly onTerminal?: (
    type: "turn.completed" | "turn.failed" | "turn.interrupted",
  ) => Promise<void>;
}

export async function prepareAdmittedTurnModel(input: {
  readonly env: Env;
  readonly run: Pick<RunRecord, "id" | "providerId" | "modelId">;
  readonly userId: string;
  readonly workspaceId: string;
  readonly configuration: AdmittedTurnExecution["configuration"];
}): Promise<ChatModelMetadata> {
  const modelMetadata = await resolveChatModelMetadata({
    providerId:
      input.configuration.providerId ?? input.run.providerId ?? undefined,
    modelId: input.configuration.modelId ?? input.run.modelId ?? undefined,
    fetchModels: (providerId, query) =>
      fetchRunProviderModels(input.env, {
        runId: input.run.id,
        userId: input.userId,
        workspaceId: input.workspaceId,
        providerId,
        query,
        requestedBackend: "execution-engine-v1",
      }),
  });
  const reasoningEffort = input.configuration.reasoningEffort;
  if (reasoningEffort) {
    const error = validateChatReasoningEffort(reasoningEffort, modelMetadata);
    if (error) throw new Error(error);
  }
  return modelMetadata;
}

/** Dispatches a transactionally admitted prompt through the same Brain use case as normal chat. */
export async function dispatchAdmittedTurn(
  input: AdmittedTurnExecution,
): Promise<void> {
  const dispatch = async () => {
    let executionPayload: Awaited<
      ReturnType<HandleChatRequest["execute"]>
    >["executionPayload"];
    try {
      const modelMetadata =
        input.modelMetadata ?? (await prepareAdmittedTurnModel(input));
      const promptMessage = {
        id: input.promptMessageId,
        role: "user" as const,
        content: input.prompt,
      };
      const result = await new HandleChatRequest(input.env).execute(
        {
          sessionId: input.sessionId,
          runId: input.run.id,
          userId: input.userId,
          workspaceId: input.workspaceId,
          correlationId: input.correlationId,
          agentType: mapAgentIdToType("coding", input.correlationId),
          mode: toRuntimeRunMode(input.configuration.mode ?? input.run.mode),
          prompt: input.prompt,
          messages: [promptMessage],
          providerId:
            input.configuration.providerId ?? input.run.providerId ?? undefined,
          modelId:
            input.configuration.modelId ?? input.run.modelId ?? undefined,
          harnessId: input.configuration.harnessId,
          productMode: input.configuration.productMode,
          reasoningEffort: input.configuration.reasoningEffort,
          contextWindowTokens: modelMetadata.contextWindow,
          pricing: modelMetadata.pricing,
          providerRuntimeRoute: modelMetadata.runtimeRoute,
          modelCapabilities: modelMetadata.capabilities,
          modelInputModalities: modelMetadata.inputModalities,
          repositoryBranch:
            input.run.branch ?? input.repository?.repositoryBranch,
          repositoryOwner: input.repository?.repositoryOwner,
          repositoryName: input.repository?.repositoryName,
          repositoryBaseUrl: input.repository?.repositoryBaseUrl,
          identity: input.identity,
          preAdmitted: {
            run: input.run,
            promptMessageId: input.promptMessageId,
            ...(input.resumeSnapshotRef
              ? { resumeSnapshotRef: input.resumeSnapshotRef }
              : {}),
          },
        },
        input.request.headers.get("Origin") ?? undefined,
      );
      ExecuteRunPayloadSchema.parse(result.executionPayload);
      executionPayload = result.executionPayload;
    } catch (error) {
      try {
        const settled = await input.onStartupFailure(error);
        if (settled) await input.onDispatchSettled();
      } catch (settlementError) {
        console.error(
          "[thread-input/startup] failed to settle pre-dispatch failure",
          {
            correlationId: input.correlationId,
            turnId: input.identity.turnId,
            error: sanitizeUnknownError(settlementError),
          },
        );
      }
      throw error;
    }
    const response = await executeViaRunEngineDurableObject(
      input.env,
      input.run.id,
      executionPayload,
    );
    await response.arrayBuffer();
    const terminal = await readRunTerminal(
      input.env,
      input.run.id,
      input.identity.turnId,
    );
    if (terminal) await input.onDispatchSettled();
    if (terminal) await input.onTerminal?.(terminal);
    if (!response.ok) {
      const error = new Error(
        `RunEngine rejected admitted turn with HTTP ${response.status}`,
      );
      if (response.status === 400) {
        const settled = await input.onStartupFailure(error);
        if (settled) await input.onDispatchSettled();
      }
      throw error;
    }
  };

  const task = dispatch().catch((error: unknown) => {
    console.error("[thread-input/dispatch] admitted turn execution failed", {
      correlationId: input.correlationId,
      runId: input.run.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  if (input.executionContext) input.executionContext.waitUntil(task);
  else await task;
}

export async function settleUnclaimedStartupFailure(input: {
  readonly env: Env;
  readonly userId: string;
  readonly sessionId: string;
  readonly run: RunRecord;
  readonly workspaceId: string;
  readonly identity: TurnScopeBootstrap;
  readonly correlationId: string;
  readonly error: unknown;
}): Promise<boolean> {
  const claimId = crypto.randomUUID();
  let claim;
  try {
    claim = await withTurnAdmissionRepository(input.env, (repository) =>
      repository.claimExecution({
        turnId: input.identity.turnId,
        runAttemptId: input.identity.runAttemptId,
        runId: input.run.id,
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: input.identity.threadId,
        claimId,
      }),
    );
  } catch (error) {
    console.error(
      "[thread-input/startup] could not claim pre-dispatch failure",
      {
        correlationId: input.correlationId,
        turnId: input.identity.turnId,
        error: sanitizeUnknownError(error),
      },
    );
    return false;
  }
  if (claim.status !== "claimed") {
    console.warn(
      "[thread-input/startup] pre-dispatch failure could not claim admitted turn",
      {
        correlationId: input.correlationId,
        turnId: input.identity.turnId,
        claimStatus: claim.status,
      },
    );
    return false;
  }

  const failure: ProtocolError = {
    code: "workspace_prepare_failed",
    message: sanitizeStartupFailure(input.error),
    retryable: true,
    correlationId: input.correlationId || null,
    details: null,
  };
  let result;
  try {
    result = await settleOwnedStartupFailure({
      store: new BrainLifecycleEventStore(input.env),
      claim: { turnId: input.identity.turnId, claimId },
      identity: {
        turnId: input.identity.turnId,
        runAttemptId: input.identity.runAttemptId,
        threadId: input.identity.threadId,
        workspaceId: workspaceIdFromExternalId(input.workspaceId),
        admittedWorkspaceId: input.workspaceId,
        userId: input.userId,
        sessionId: input.sessionId,
        runId: input.run.id,
        correlationId: input.correlationId,
        ...(input.identity.revisionOfTurnId
          ? { revisionOfTurnId: input.identity.revisionOfTurnId }
          : {}),
      },
      markRecoveryRequired: (executionClaim) =>
        withTurnAdmissionRepository(input.env, (repository) =>
          repository.markRecoveryRequired(executionClaim),
        ),
      readAdmission: () =>
        withTurnAdmissionRepository(input.env, (repository) =>
          repository.getByTurnId(input.identity.turnId),
        ),
      interruptReason: null,
      failure,
    });
  } catch (error) {
    console.error("[thread-input/startup] admitted turn settlement failed", {
      correlationId: input.correlationId,
      turnId: input.identity.turnId,
      error: sanitizeUnknownError(error),
    });
    return false;
  }
  if (result.status !== "settled" && result.status !== "terminal_exists") {
    console.error(
      "[thread-input/startup] admitted turn settlement requires recovery",
      {
        correlationId: input.correlationId,
        turnId: input.identity.turnId,
        settlementStatus: result.status,
      },
    );
    return false;
  }
  return true;
}

function sanitizeStartupFailure(error: unknown): string {
  return (
    sanitizeUnknownError(error).slice(0, 10_000) ||
    "Runtime setup failed before execution began."
  );
}

export async function readRunTerminal(
  env: Env,
  runId: string,
  turnId: string,
): Promise<"turn.completed" | "turn.failed" | "turn.interrupted" | null> {
  let afterSequence: number | null = null;
  while (true) {
    const query = new URLSearchParams({ turnId, limit: "1000" });
    if (afterSequence !== null)
      query.set("afterSequence", String(afterSequence));
    const response = await fetchRunRuntimeRoute(
      env,
      runId,
      "execution-engine-v1",
      {
        method: "GET",
        path: `/lifecycle-events?${query.toString()}`,
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      events?: unknown;
      nextSequence?: unknown;
    };
    if (!Array.isArray(body.events)) return null;
    for (const event of body.events) {
      if (typeof event !== "object" || event === null || !("type" in event))
        continue;
      const type = (event as { type?: unknown }).type;
      if (
        type === "turn.completed" ||
        type === "turn.failed" ||
        type === "turn.interrupted"
      )
        return type;
    }
    if (body.events.length < 1_000 || typeof body.nextSequence !== "number")
      return null;
    if (body.nextSequence === afterSequence)
      throw new Error(`Lifecycle cursor did not advance for turn ${turnId}`);
    afterSequence = body.nextSequence;
  }
}
