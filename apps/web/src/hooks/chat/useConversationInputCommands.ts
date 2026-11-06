import { useCallback, useMemo, type MutableRefObject } from "react";
import {
  createConversationInputCommands,
  ThreadInputConfigurationSchema,
} from "@legioncode/sdk";
import type { ProductMode, RunMode, ReasoningEffort } from "@repo/shared-types";
import type { ThreadInputReceipt } from "@legioncode/sdk";
import type { PlatformClient } from "@legioncode/sdk";
import type { ChatImageAttachment } from "@legioncode/client-ui";
import { resolveReasoningEffortForRequest } from "../../lib/model-reasoning-preferences";
import { resolveRuntimeHarnessId } from "../../lib/chat-request";
import {
  createConversationScope,
} from "../conversationScope";
import type { ConversationScope } from "@legioncode/sdk";

export function useConversationInputCommands(input: {
  sessionId: string;
  runId: string;
  onRunIdChange?: (runId: string) => void;
  mode: RunMode;
  productMode?: ProductMode;
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
  selectedModelEfforts?: readonly ReasoningEffort[];
  lifecycleClient: Pick<PlatformClient, "steerTurn" | "enqueueThreadInput" | "resumeTurn">;
  scopeRef: MutableRefObject<ConversationScope | null>;
  runScopeRef: MutableRefObject<string>;
  generationRef: MutableRefObject<number>;
  latestInputRef: MutableRefObject<string>;
  inputVersionRef: MutableRefObject<number>;
  isActiveRunInvocation: (runScopeKey: string, generation: number) => boolean;
  clearInput: () => void;
  setError: (error: string | null) => void;
  commitScope: (scope: ConversationScope) => void;
}) {
  const commands = useMemo(() => createConversationInputCommands(), []);
  const submitFollowUp = useCallback(
    async (
      text: string,
      attachments: { imageAttachments?: ChatImageAttachment[] } | undefined,
      delivery: "queue" | "steer",
    ): Promise<boolean> => {
      const capturedScope = input.scopeRef.current;
      const capturedRunScope = input.runScopeRef.current;
      const capturedGeneration = input.generationRef.current;
      const capturedText = text;
      const capturedDraftVersion = input.inputVersionRef.current;
      const images = (attachments?.imageAttachments ?? []).map((image) => ({
        dataUrl: image.dataUrl,
        name: image.name,
        mediaType: image.mediaType,
      }));
      if (!capturedScope || (!capturedText.trim() && images.length === 0)) {
        return false;
      }

      let configuration: ReturnType<typeof ThreadInputConfigurationSchema.parse>;
      try {
        configuration = buildInputConfiguration(input);
      } catch {
        input.setError(
          "Conversation settings are invalid. Check the selected provider, model, and reasoning effort.",
        );
        return false;
      }
      const fingerprint = JSON.stringify({
        workspaceId: capturedScope.workspaceId,
        threadId: capturedScope.threadId,
        turnId: capturedScope.turnId,
        runAttemptId: capturedScope.runAttemptId,
        delivery,
        capturedDraftVersion,
        ...(delivery === "queue" ? { configuration } : {}),
        text: capturedText,
        images: (attachments?.imageAttachments ?? []).map((image) => ({
          id: image.id,
          name: image.name,
          mediaType: image.mediaType,
        })),
      });
      try {
        const receipt = await commands.submitFollowUp(input.lifecycleClient, {
          fingerprint,
          scope: capturedScope,
          delivery,
          content: { text: capturedText, images },
          configuration,
        });
        if (
          !input.isActiveRunInvocation(capturedRunScope, capturedGeneration) ||
          input.scopeRef.current?.sessionId !== capturedScope.sessionId ||
          input.scopeRef.current?.runId !== capturedScope.runId ||
          input.scopeRef.current?.threadId !== capturedScope.threadId ||
          input.scopeRef.current?.workspaceId !== capturedScope.workspaceId ||
          input.scopeRef.current?.turnId !== capturedScope.turnId ||
          input.scopeRef.current?.runAttemptId !== capturedScope.runAttemptId
        ) {
          return false;
        }
        if (receipt.status === "conflict") {
          input.setError(receipt.message);
          return false;
        }
        if (
          (delivery === "steer" &&
            receipt.status !== "accepted" &&
            receipt.status !== "applied" &&
            receipt.status !== "unconfirmed") ||
          (delivery === "queue" &&
            receipt.status !== "pending" &&
            receipt.status !== "started")
        ) {
          input.setError(
            "The server returned an unexpected follow-up receipt.",
          );
          return false;
        }
        if (receipt.status === "started") {
          const nextScope = createConversationScope({
            workspaceId: capturedScope.workspaceId,
            threadId: capturedScope.threadId,
            turnId: receipt.turnId,
            runAttemptId: receipt.runAttemptId,
            sessionId: capturedScope.sessionId,
            runId: receipt.runId,
          });
          input.onRunIdChange?.(receipt.runId);
          input.commitScope(nextScope);
        }
        if (
          input.inputVersionRef.current === capturedDraftVersion &&
          input.latestInputRef.current === capturedText
        ) {
          input.clearInput();
        }
        return true;
      } catch (submitError) {
        if (input.isActiveRunInvocation(capturedRunScope, capturedGeneration)) {
          input.setError(
            submitError instanceof Error
              ? submitError.message
              : "Follow-up could not be submitted.",
          );
        }
        return false;
      }
    },
    [commands, input],
  );

  const resumeInterruptedTurn = useCallback(
    async (expectedTerminalSequence: number): Promise<boolean> => {
      const capturedScope = input.scopeRef.current;
      const capturedRunScope = input.runScopeRef.current;
      const capturedGeneration = input.generationRef.current;
      if (!capturedScope) return false;
      let configuration: ReturnType<typeof ThreadInputConfigurationSchema.parse>;
      try {
        configuration = buildInputConfiguration(input);
      } catch {
        input.setError(
          "Conversation settings are invalid. Check the selected provider, model, and reasoning effort.",
        );
        return false;
      }
      const fingerprint = JSON.stringify({
        workspaceId: capturedScope.workspaceId,
        threadId: capturedScope.threadId,
        turnId: capturedScope.turnId,
        runAttemptId: capturedScope.runAttemptId,
        expectedTerminalSequence,
        configuration,
      });
      try {
        const receipt = await commands.resumeInterruptedTurn(input.lifecycleClient, {
          fingerprint,
          scope: capturedScope,
          expectedTerminalSequence,
          configuration,
        });
        if (
          !input.isActiveRunInvocation(capturedRunScope, capturedGeneration) ||
          input.scopeRef.current?.threadId !== capturedScope.threadId ||
          input.scopeRef.current?.workspaceId !== capturedScope.workspaceId ||
          input.scopeRef.current?.runId !== capturedScope.runId ||
          input.scopeRef.current?.turnId !== capturedScope.turnId ||
          input.scopeRef.current?.runAttemptId !== capturedScope.runAttemptId
        ) {
          return false;
        }
        if (receipt.status === "conflict") {
          input.setError(receipt.message);
          return false;
        }
        const nextScope = createConversationScope({
          workspaceId: capturedScope.workspaceId,
          threadId: capturedScope.threadId,
          turnId: receipt.turnId,
          runAttemptId: receipt.runAttemptId,
          continuationOfTurnId: receipt.continuationOfTurnId,
          originalPromptId: receipt.originalPromptId,
          sessionId: capturedScope.sessionId,
          runId: receipt.runId,
        });
        input.onRunIdChange?.(receipt.runId);
        input.commitScope(nextScope);
        return true;
      } catch (resumeError) {
        if (input.isActiveRunInvocation(capturedRunScope, capturedGeneration)) {
          input.setError(
            resumeError instanceof Error
              ? resumeError.message
              : "Interrupted turn could not be resumed.",
          );
        }
        return false;
      }
    },
    [commands, input],
  );

  const applyStartedQueueReceipt = useCallback(
    (
      receipt: Extract<ThreadInputReceipt, { status: "started" }>,
      expectedScope: ConversationScope,
    ) => {
      const currentScope = input.scopeRef.current;
      if (
        !currentScope ||
        currentScope.sessionId !== expectedScope.sessionId ||
        currentScope.runId !== expectedScope.runId ||
        currentScope.workspaceId !== expectedScope.workspaceId ||
        currentScope.threadId !== expectedScope.threadId ||
        currentScope.turnId !== expectedScope.turnId ||
        currentScope.runAttemptId !== expectedScope.runAttemptId
      ) {
        return false;
      }
      const nextScope = createConversationScope({
        workspaceId: currentScope.workspaceId,
        threadId: currentScope.threadId,
        turnId: receipt.turnId,
        runAttemptId: receipt.runAttemptId,
        sessionId: currentScope.sessionId,
        runId: receipt.runId,
      });
      input.onRunIdChange?.(receipt.runId);
      input.commitScope(nextScope);
      return true;
    },
    [input],
  );

  return { submitFollowUp, resumeInterruptedTurn, applyStartedQueueReceipt };
}

function buildInputConfiguration(input: {
  sessionId: string;
  mode: RunMode;
  productMode?: ProductMode;
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
  selectedModelEfforts?: readonly ReasoningEffort[];
}) {
  return ThreadInputConfigurationSchema.parse({
    mode: input.mode === "build" ? "auto_edit" : input.mode,
    ...(input.productMode ? { productMode: input.productMode } : {}),
    harnessId: resolveRuntimeHarnessId(input.sessionId),
    ...(input.selectedProviderId && input.selectedModelId
      ? { providerId: input.selectedProviderId, modelId: input.selectedModelId }
      : {}),
    ...(input.selectedProviderId && input.selectedModelId
      ? (() => {
          const reasoningEffort = resolveReasoningEffortForRequest(
            input.selectedProviderId!,
            input.selectedModelId!,
            input.selectedModelEfforts,
          );
          return reasoningEffort ? { reasoningEffort } : {};
        })()
      : {}),
  });
}
