import type { GenerationParams } from "@legioncode/execution-engine/runtime/provider/base/ProviderAdapter";
import type { BYOKModelCapability, ProviderModelTransport } from "@repo/shared-types";

export type ThreadTitleMessage = GenerationParams["messages"][number];
export interface BackgroundTaskOwner { waitUntil(promise: Promise<unknown>): void; }

/** Durable conversation identities; hosts retain their existing persistence authority. */
export interface ThreadTitleScope {
  threadId: string;
  runId: string;
  workspaceId: string;
  userId: string;
  firstMessageId: string;
}
export interface HostedThreadTitleScope extends ThreadTitleScope { sessionId: string; }
interface AutomatedTitleMetadata {
  title: string;
  source: "preview" | "generated";
  titleStatus?: "pending" | "ready" | "failed";
  expectedTitleVersion?: number;
  initialOnly?: boolean;
}
export type PersistThreadTitleInput<TScope extends ThreadTitleScope = HostedThreadTitleScope> =
  TScope & AutomatedTitleMetadata;
export type GenerateThreadTitleInput<TScope extends ThreadTitleScope = HostedThreadTitleScope> =
  TScope & Omit<AutomatedTitleMetadata, "title" | "source"> & {
    prompt: string;
    previewVersion: number;
    providerId?: string;
    modelId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    modelCapabilities?: BYOKModelCapability;
  };
export interface ThreadTitleGenerator {
  outputFormat?: "text" | "json";
  generateText(input: {
    messages: ThreadTitleMessage[];
    model?: string;
    providerId?: string;
    runtimeModelId?: string;
    providerTransport?: ProviderModelTransport;
    providerEndpoint?: string;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    finishReason?: string;
    usage?: { totalTokens: number };
  }>;
}
export interface ThreadTitlePersistence<TScope extends ThreadTitleScope = HostedThreadTitleScope> {
  persist(input: PersistThreadTitleInput<TScope>): Promise<unknown>;
  persistFailure?(input: TScope & Omit<AutomatedTitleMetadata, "title" | "source" | "titleStatus"> & {
    prompt: string;
  }): Promise<unknown>;
}
export interface ThreadTitleGenerationDependencies<TScope extends ThreadTitleScope = HostedThreadTitleScope> {
  generator?: ThreadTitleGenerator;
  generatorFactory: (input: GenerateThreadTitleInput<TScope>) => ThreadTitleGenerator;
  fallbackGenerator?: ThreadTitleGenerator;
  titleService: ThreadTitlePersistence<TScope>;
}
/** Existing hosted fallback selection; local hosts provide no platform fallback. */
export const OPENROUTER_FREE_MODEL_ID = "openrouter/free";
