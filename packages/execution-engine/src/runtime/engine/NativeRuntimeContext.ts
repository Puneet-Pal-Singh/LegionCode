import type { CoreMessage, CoreTool } from "ai";
import {
  ContextBudgetSnapshotSchema,
  JsonRecordSchema,
} from "@repo/platform-protocol";
import type {
  ContextAssemblyPort,
  ContextCompactionPort,
  ToolResult,
} from "@repo/runtime-kernel";
import type { RunInput } from "../types.js";
import { buildAgenticLoopSystemPrompt } from "./AgenticLoop.js";
import {
  buildProviderContextMessages,
  estimateConversationTokens,
  estimateAttachmentTokens,
  summarizeConversationForCompaction,
} from "./NativeProviderContextMessages.js";

export function createNativeContextAssembly(
  input: RunInput,
  readMessages: (
    toolResults?: readonly ToolResult[],
  ) => Promise<readonly CoreMessage[]>,
  tools: Readonly<Record<string, CoreTool>>,
): ContextAssemblyPort {
  return {
    assemble: async ({ toolResults }) => {
      const messages = await readMessages(toolResults);
      const repositoryText = JSON.stringify(input.repositoryContext ?? {});
      const conversationTokens = estimateConversationTokens(messages);
      const repositoryContextTokens = Math.ceil(repositoryText.length / 4);
      const systemTokens = Math.ceil(
        buildAgenticLoopSystemPrompt({
          finalSynthesisOnly: false,
          requiresMutation: false,
          completedMutatingToolCount: 0,
          completedReadOnlyToolCount: 0,
          explicitCiLogRequest: false,
          encounteredCiLogsAuthorizationBoundary: false,
          attemptedCiLogsCliFallback: false,
        }).length / 4,
      );
      const toolDefinitionTokens = Math.ceil(JSON.stringify(tools).length / 4);
      const attachmentTokens = estimateAttachmentTokens(messages);
      const contextWindowLimit = readPositiveInteger(
        input.metadata?.contextWindowTokens,
      );
      if (!contextWindowLimit) {
        return {
          instructions: input.prompt,
          metadata: JsonRecordSchema.parse({
            repositoryContext: input.repositoryContext ?? {},
          }),
        };
      }
      const reservedOutputTokens = Math.min(
        8_192,
        Math.floor(contextWindowLimit * 0.1),
      );
      const safetyReserveTokens = Math.min(
        4_096,
        Math.floor(contextWindowLimit * 0.05),
      );
      const effectiveInputBudget = Math.max(
        1,
        contextWindowLimit - reservedOutputTokens - safetyReserveTokens,
      );
      const tokensUsed =
        systemTokens +
        conversationTokens +
        attachmentTokens +
        toolDefinitionTokens +
        repositoryContextTokens;
      const snapshot = ContextBudgetSnapshotSchema.parse({
        providerId: input.providerId ?? "unknown",
        modelId: input.runtimeModelId ?? input.modelId ?? "unknown",
        contextWindowLimit,
        systemTokens,
        conversationTokens,
        toolDefinitionTokens,
        attachmentTokens,
        repositoryContextTokens,
        reservedOutputTokens,
        safetyReserveTokens,
        effectiveInputBudget,
        tokensUsed,
        tokensRemaining: Math.max(0, effectiveInputBudget - tokensUsed),
        utilizationPercent: Math.min(
          100,
          (tokensUsed / effectiveInputBudget) * 100,
        ),
        warningThresholdPercent: 70,
        automaticCompactionThresholdPercent: 90,
        measurementSource: "estimate",
      });
      return {
        instructions: input.prompt,
        metadata: JsonRecordSchema.parse({
          repositoryContext: input.repositoryContext ?? {},
        }),
        budgetSnapshot: snapshot,
      };
    },
  };
}

export function createNativeContextCompaction(
  input: RunInput,
  readMessages: (
    toolResults?: readonly ToolResult[],
  ) => Promise<readonly CoreMessage[]>,
): ContextCompactionPort {
  return {
    compact: async ({ context, turn }) => {
      const messages = await readMessages();
      const summary = summarizeConversationForCompaction(
        messages,
        input.prompt,
      );
      const budget = context.budgetSnapshot;
      const compactedMessages = buildProviderContextMessages({
        messages,
        compactedContext: summary,
      });
      const conversationTokens = estimateConversationTokens(compactedMessages);
      const attachmentTokens = estimateAttachmentTokens(compactedMessages);
      const compactedTokens =
        conversationTokens +
        attachmentTokens +
        (budget?.systemTokens ?? 0) +
        (budget?.toolDefinitionTokens ?? 0) +
        (budget?.repositoryContextTokens ?? 0);
      const compactedBudget = budget
        ? ContextBudgetSnapshotSchema.parse({
            ...budget,
            conversationTokens,
            attachmentTokens,
            measurementSource: "estimate",
            tokensUsed: compactedTokens,
            tokensRemaining: Math.max(
              0,
              budget.effectiveInputBudget - compactedTokens,
            ),
            utilizationPercent: Math.min(
              100,
              (compactedTokens / budget.effectiveInputBudget) * 100,
            ),
          })
        : undefined;
      return {
        context: {
          instructions: context.instructions,
          metadata: JsonRecordSchema.parse({
            ...context.metadata,
            compactedContext: summary,
            compactedTurnId: turn.id,
          }),
          ...(compactedBudget ? { budgetSnapshot: compactedBudget } : {}),
          ...(context.usage ? { usage: context.usage } : {}),
        },
        preservedContextReference: `context:${turn.id}:compacted`,
        summary,
      };
    },
  };
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
