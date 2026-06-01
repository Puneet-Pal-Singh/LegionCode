import type { CoreMessage, CoreTool } from "ai";
import type { ZodSchema } from "zod";
import type { ProviderModelTransport } from "@repo/shared-types";
import type { LLMUsage } from "../cost/index.js";

export type LLMPhase = "planning" | "task" | "synthesis" | "memory";
export type LLMExecutionLane =
  | "chat_only"
  | "single_agent_action"
  | "structured_planning_required";
export type LLMExecutionReliabilityTier =
  | "experimental"
  | "baseline"
  | "hardened";
export type LLMExecutionLatencyTier = "slow" | "standard" | "fast";

export interface LLMCallContext {
  runId: string;
  sessionId: string;
  taskId?: string;
  agentType: string;
  phase: LLMPhase;
  idempotencyKey?: string;
}

export interface LLMTextRequest {
  context: LLMCallContext;
  model?: string;
  providerId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
  messages: CoreMessage[];
  temperature?: number;
  system?: string;
  tools?: Record<string, CoreTool>;
  timeoutMs?: number;
}

export interface LLMStructuredRequest<T> {
  context: LLMCallContext;
  model?: string;
  providerId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
  messages: CoreMessage[];
  schema: ZodSchema<T>;
  temperature?: number;
  timeoutMs?: number;
}

export interface LLMTextResponse {
  text: string;
  usage: LLMUsage;
  providerRequestId?: string;
  finishReason?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMStructuredResponse<T> {
  object: T;
  usage: LLMUsage;
  providerRequestId?: string;
}

export interface ProviderCapabilityFlags {
  streaming: boolean;
  tools: boolean;
  structuredOutputs: boolean;
  jsonMode: boolean;
}

export interface ProviderExecutionLaneSupport {
  supported: boolean;
  reason?: string;
}

export interface ProviderExecutionProfile {
  latencyTier: LLMExecutionLatencyTier;
  reliabilityTier: LLMExecutionReliabilityTier;
  supportedLanes: Record<LLMExecutionLane, ProviderExecutionLaneSupport>;
}

export interface ProviderCapabilityResolver {
  getCapabilities(providerId: string): ProviderCapabilityFlags | undefined;
  isModelAllowed(providerId: string, modelId: string): boolean;
  getExecutionProfile(
    providerId: string,
    modelId: string,
  ): ProviderExecutionProfile | undefined;
}

export interface ILLMGateway {
  generateText(req: LLMTextRequest): Promise<LLMTextResponse>;
  generateStructured<T>(
    req: LLMStructuredRequest<T>,
  ): Promise<LLMStructuredResponse<T>>;
  generateStream(req: LLMTextRequest): Promise<ReadableStream<Uint8Array>>;
}

export interface LLMRuntimeAIService {
  getProvider(): string;
  getDefaultModel(): string;
  generateText(input: {
    messages: CoreMessage[];
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
    system?: string;
    tools?: Record<string, CoreTool>;
  }): Promise<{
    text: string;
    usage: LLMUsage;
    finishReason?: string;
    toolCalls?: Array<{
      toolName: string;
      args: unknown;
    }>;
  }>;
  generateStructured<T>(input: {
    messages: CoreMessage[];
    schema: ZodSchema<T>;
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
  }): Promise<{ object: T; usage: LLMUsage }>;
  createChatStream(input: {
    messages: CoreMessage[];
    system?: string;
    tools?: Record<string, CoreTool>;
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
    onFinish?: (result: { usage: LLMUsage }) => void | Promise<void>;
  }): Promise<ReadableStream<Uint8Array>>;
}

export interface LLMToolCall {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}
