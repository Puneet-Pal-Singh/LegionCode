import type { CoreMessage } from "ai";
import { RUN_TERMINAL_STATES } from "@repo/shared-types";
import type { Run } from "../run/index.js";
import type { RunInput } from "../types.js";
import type { ILLMGateway } from "../llm/index.js";
import { buildConversationalSystemPrompt } from "./ConversationPolicy.js";
import { finalizeRunWithAssistantMessage } from "./RunCompletionPolicy.js";
import type { RunCompletionDependencies } from "./RunCompletionPolicy.js";
import { recordLifecycleStep } from "./RunMetadataPolicy.js";
import { isHeuristicActionTurn } from "./RunTurnModePolicy.js";

export function shouldUseNativeConversationalTurn(input: RunInput): boolean {
  if ((input.mode ?? "build") !== "build") {
    return false;
  }
  return !isHeuristicActionTurn(input.prompt);
}

export async function executeNativeConversationalTurn(input: {
  run: Run;
  runInput: RunInput;
  messages: CoreMessage[];
  llmGateway: ILLMGateway;
  deps: RunCompletionDependencies;
}): Promise<Response> {
  recordLifecycleStep(input.run, "TASK_EXECUTING", "chat");
  const response = await input.llmGateway.generateText({
    context: {
      runId: input.run.id,
      sessionId: input.run.sessionId,
      agentType: input.run.agentType,
      phase: "task",
      idempotencyKey: `runtime-kernel-native:${input.run.id}:chat`,
    },
    messages: input.messages,
    system: buildConversationalSystemPrompt(),
    model: input.runInput.modelId,
    providerId: input.runInput.providerId,
    runtimeModelId: input.runInput.runtimeModelId,
    providerTransport: input.runInput.providerTransport,
    providerEndpoint: input.runInput.providerEndpoint,
    temperature: 0.2,
  });

  return finalizeRunWithAssistantMessage({
    run: input.run,
    text: response.text,
    metadata: { terminalState: RUN_TERMINAL_STATES.COMPLETED },
    deps: input.deps,
  });
}
