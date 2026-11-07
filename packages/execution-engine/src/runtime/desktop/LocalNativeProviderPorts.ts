import { selectLocalCapturedTools } from "./LocalCapturedExecution.js";
import type { LocalCapturedExecutionPorts } from "./LocalTurnExecutionCapability.js";
import type { CoreMessage, CoreTool } from "ai";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import type { RuntimeKernelDependencies } from "@repo/runtime-kernel";
import type { RunInput } from "../types.js";
import type { ILLMGateway } from "../llm/types.js";
import {
  KernelAgenticProvider,
  type KernelAgenticProviderOptions,
  type NativeProviderToolTracker,
} from "../engine/KernelAgenticProvider.js";
import {
  createNativeContextAssembly,
  createNativeContextCompaction,
} from "../engine/NativeRuntimeContext.js";
import { getAgenticLoopMaxSteps } from "../engine/RunAgenticLoopPolicy.js";
import { getCodingCoreToolRegistry } from "../tools/CodingToolRegistry.js";
import { LOCAL_READ_ONLY_TOOL_IDS } from "./LocalReadOnlyExecutionService.js";

/** Adapts trusted local admission/history to the same provider/context owner used by the native runner. */
export function createLocalNativeProviderPorts(options: {
  readonly admission: TurnAdmission;
  readonly messages: CoreMessage[];
  readonly gateway: Pick<ILLMGateway, "generateText">;
  readonly signal: AbortSignal;
  readonly routing?: Pick<
    RunInput,
    "runtimeModelId" | "providerTransport" | "providerEndpoint"
  >;
  readonly metadata?: RunInput["metadata"];
  readonly repositoryContext?: RunInput["repositoryContext"];
  readonly budget?: KernelAgenticProviderOptions["budget"];
  readonly execution?: Pick<
    LocalCapturedExecutionPorts,
    "availableToolIds" | "backendCapabilities" | "tools"
  >;
}): Pick<
  RuntimeKernelDependencies,
  "provider" | "contextAssembly" | "contextCompaction"
> & {
  readonly toolTracker: NativeProviderToolTracker;
} {
  const { admission } = options;
  if (
    admission.userMessage.type !== "user_message" ||
    typeof admission.userMessage.content.text !== "string"
  ) {
    throw new Error("Native provider requires the admitted user prompt");
  }
  const input: RunInput = {
    agentType: "coding",
    mode: options.execution ? "build" : "plan",
    prompt: admission.userMessage.content.text,
    // The legacy gateway field carries the actual local Thread identity, never a fabricated hosted Session.
    sessionId: admission.run.threadId,
    providerId: admission.run.providerId,
    modelId: admission.run.modelId,
    ...options.routing,
    metadata: options.metadata,
    repositoryContext: options.repositoryContext,
  };
  if (options.execution && admission.run.mode !== "auto_edit") {
    throw new Error(
      "Captured tools require the runtime's mutating admission mode",
    );
  }
  const tools: Record<string, CoreTool> = options.execution
    ? { ...selectLocalCapturedTools(options.execution) }
    : {};
  if (!options.execution) {
    const registry = getCodingCoreToolRegistry();
    for (const id of LOCAL_READ_ONLY_TOOL_IDS) {
      const tool = registry[id];
      if (!tool) throw new Error("Registered local read tool is unavailable");
      tools[id] = tool;
    }
  }
  const provider = new KernelAgenticProvider({
    runId: admission.run.id,
    conversationId: admission.run.threadId,
    agentType: input.agentType,
    input,
    messages: options.messages,
    tools,
    llmGateway: options.gateway,
    budget: options.budget,
    isRunCancelled: async () => options.signal.aborted,
    maxSteps: getAgenticLoopMaxSteps(options.metadata),
  });
  return {
    provider,
    toolTracker: provider,
    contextAssembly: createNativeContextAssembly(
      input,
      provider.readContextMessages.bind(provider),
      tools,
    ),
    contextCompaction: createNativeContextCompaction(
      input,
      provider.readContextMessages.bind(provider),
      provider.readTaskContextProjection.bind(provider),
    ),
  };
}
