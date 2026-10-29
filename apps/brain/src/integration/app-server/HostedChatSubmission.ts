import type { AgentType } from "@legioncode/execution-engine/runtime";
import { HandleChatRequest } from "../../application/chat";
import type { Env } from "../../types/ai";
import { errorResponse, withEngineHeaders } from "../../http/response";
import { mapAgentIdToType } from "../../controllers/chat-request-helpers";
import {
  executeViaRunEngineDurableObject,
  extractPromptFromMessages,
  fetchRunProviderModels,
  resolveRuntimeTarget,
} from "../../controllers/chat-runtime-helpers";
import { RunAdmissionService } from "../../runtime/RunAdmissionService";
import { resolveChatModelMetadata } from "../../services/chat/ChatModelMetadataResolution";
import type { ChatModelMetadata } from "../../services/chat/ChatModelMetadataResolver";
import { validateChatReasoningEffort } from "../../services/chat/ChatReasoningEffortPolicy";
import {
  applySubmittedClientMessageId,
  summarizeCoreMessages,
} from "../../services/chat/SubmittedClientMessagePolicy";
import { formatDiagnosticLogLine } from "../../lib/diagnostic-log";
import { ThreadInputCommandService } from "../../services/thread-inputs/ThreadInputCommandService";
import type { AuthenticatedChatRequest } from "../../controllers/ChatRequestBoundary";
import type { BackgroundTaskOwner } from "../../services/thread-titles";
import type { HostedChatSubmissionResult } from "@repo/platform-protocol";

export function hostedChatSubmissionResult(
  response: Response,
): HostedChatSubmissionResult {
  return {
    runtimeStatus: response.status,
    runId: response.headers.get("X-Run-Id"),
    threadId: response.headers.get("X-Thread-Id"),
    turnId: response.headers.get("X-Turn-Id"),
    runAttemptId: response.headers.get("X-Run-Attempt-Id"),
  };
}

/** Runs the existing authorized chat submission through its canonical admission and runtime owners. */
export async function submitHostedChat(
  req: Request,
  chatRequest: AuthenticatedChatRequest,
  env: Env,
  backgroundTaskOwner?: BackgroundTaskOwner,
  executionContext?: ExecutionContext,
): Promise<Response> {
  const {
    body,
    correlationId,
    sessionId,
    runId,
    userId,
    workspaceId,
    identity,
  } = chatRequest;
  const admissionService = new RunAdmissionService(env);
  let admissionGrant:
    | Awaited<ReturnType<RunAdmissionService["enforce"]>>
    | undefined;

  const coreMessages = applySubmittedClientMessageId(
    chatRequest.imageInput.messages,
    body.clientMessageId,
    correlationId,
  );
  console.log(
    `[chat/request] ${correlationId} normalizedMessages=${summarizeCoreMessages(coreMessages)}`,
  );

  const prompt = extractPromptFromMessages(coreMessages, correlationId);
  const admissionInput = {
    userId,
    workspaceId,
    threadId: identity.threadId,
    runAttemptId: identity.runAttemptId,
    mode: body.mode,
    workflowIntent: body.workflowIntent,
  };

  try {
    admissionGrant = await admissionService.enforce(
      admissionInput,
      correlationId,
    );

    const executionStartedAt = Date.now();
    const useCase = new HandleChatRequest(env);
    const trustedModelMetadata: ChatModelMetadata =
      await resolveChatModelMetadata({
        providerId: body.providerId,
        modelId: body.modelId,
        fetchModels: (_providerId, query) =>
          fetchRunProviderModels(env, {
            runId,
            userId,
            workspaceId,
            providerId: _providerId,
            query,
            requestedBackend:
              body.orchestratorBackend ?? "execution-engine-v1",
          }),
      });

    const reasoningEffortError = validateChatReasoningEffort(
      body.reasoningEffort,
      trustedModelMetadata,
    );
    if (reasoningEffortError) {
      return errorResponse(
        req,
        env,
        reasoningEffortError,
        400,
        "UNSUPPORTED_REASONING_EFFORT",
      );
    }

    const useCaseStartedAt = Date.now();
    const useCaseResult = await useCase.execute(
      {
        sessionId,
        runId,
        userId,
        workspaceId,
        correlationId,
        agentType: mapAgentIdToType(body.agentId, correlationId),
        mode: body.mode,
        prompt,
        messages: coreMessages,
        providerId: body.providerId,
        modelId: body.modelId,
        harnessId: body.harnessId,
        orchestratorBackend: body.orchestratorBackend,
        executionBackend: body.executionBackend,
        harnessMode: body.harnessMode,
        authMode: body.authMode,
        productMode: body.productMode,
        workflowIntent: body.workflowIntent,
        workflowEntrypoint: body.workflowEntrypoint,
        repositoryOwner: body.repositoryOwner,
        repositoryName: body.repositoryName,
        repositoryBranch: body.repositoryBranch,
        repositoryBaseUrl: body.repositoryBaseUrl,
        contextWindowTokens: trustedModelMetadata.contextWindow,
        pricing: trustedModelMetadata.pricing,
        providerRuntimeRoute: trustedModelMetadata.runtimeRoute,
        modelCapabilities: trustedModelMetadata.capabilities,
        modelInputModalities: trustedModelMetadata.inputModalities,
        reasoningEffort: body.reasoningEffort,
        tools: body.tools,
        identity,
        backgroundTaskOwner,
      },
      req.headers.get("Origin") || undefined,
    );
    const useCaseElapsedMs = Date.now() - useCaseStartedAt;

    const runEngineStartedAt = Date.now();
    console.log(
      formatDiagnosticLogLine("chat/runtime", "dispatching-run-engine", {
        correlationId,
        runId,
        sessionId,
        providerId: body.providerId ?? null,
        modelId: body.modelId ?? null,
        mode: body.mode,
        clientMessageId: body.clientMessageId ?? null,
      }),
    );
    const doResponse = await executeViaRunEngineDurableObject(
      env,
      runId,
      useCaseResult.executionPayload,
    );
    new ThreadInputCommandService(env).scheduleTerminalReconciliation({
      response: doResponse,
      request: req,
      executionContext,
      runId,
      turnId: identity.turnId,
      userId,
      sessionId,
      threadId: identity.threadId,
      workspaceId,
      correlationId,
    });
    const runtimeTarget = resolveRuntimeTarget(
      env,
      useCaseResult.executionPayload.input.orchestratorBackend,
    );
    const runEngineElapsedMs = Date.now() - runEngineStartedAt;
    console.log(
      formatDiagnosticLogLine("chat/runtime", "run-engine-returned", {
        correlationId,
        runId,
        sessionId,
        responseStatus: doResponse.status,
        runtimeTarget,
        elapsedMs: runEngineElapsedMs,
      }),
    );
    console.log(
      formatDiagnosticLogLine("chat/runtime", "timing", {
        correlationId,
        runId,
        sessionId,
        useCaseMs: useCaseElapsedMs,
        runEngineMs: runEngineElapsedMs,
        handleMs: Date.now() - executionStartedAt,
      }),
    );

    return withEngineHeaders(req, env, doResponse, runId, runtimeTarget);
  } catch (error) {
    console.error(
      formatDiagnosticLogLine("chat/runtime", "run-engine-failed", {
        correlationId,
        runId,
        sessionId,
        error,
      }),
      error,
    );
    throw error;
  } finally {
    if (admissionGrant) {
      await admissionService.release(admissionGrant, correlationId);
    }
  }
}
