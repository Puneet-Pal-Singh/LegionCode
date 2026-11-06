import { settleUnclaimedStartupFailure } from "./AdmittedTurnStartupFailure";
export { settleUnclaimedStartupFailure } from "./AdmittedTurnStartupFailure";
import { isDelegatedChat, assertHostedChatEnvironment } from "../chat/ChatExecutionStrategy";
import type { RunRecord } from "@repo/persistence";
import type {
  ResumeWorkspaceSnapshotRef,
  TurnScopeBootstrap,
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
    readonly harnessSelection?: import("@repo/platform-protocol").HarnessAdmissionSelection;
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
  assertHostedChatEnvironment(input.configuration.harnessSelection, input.env.APP_SERVER_ENVIRONMENT_ID);
  // No Native model discovery or reasoning-policy calls for an external loop.
  if (isDelegatedChat(input.configuration)) return {};
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
      const delegated = isDelegatedChat(input.configuration, input.correlationId);
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
          providerId: delegated ? undefined : input.configuration.providerId ?? input.run.providerId ?? undefined,
          modelId: delegated ? input.configuration.harnessSelection?.selection?.modelId : input.configuration.modelId ?? input.run.modelId ?? undefined,
          harnessId: input.configuration.harnessId,
          harnessSelection: input.configuration.harnessSelection,
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
            harnessSelection: input.configuration.harnessSelection,
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
