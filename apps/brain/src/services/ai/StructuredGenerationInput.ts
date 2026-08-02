import type { CoreMessage } from "ai";
import type { ProviderModelTransport } from "@repo/shared-types";
import type { ZodSchema } from "zod";

export interface StructuredGenerationInput<T> {
  messages: CoreMessage[];
  schema: ZodSchema<T>;
  model?: string;
  providerId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}
