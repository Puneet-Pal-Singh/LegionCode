import type { CoreMessage, CoreTool } from "ai";
import type {
  ProviderModelTransport,
  ReasoningEffort,
} from "@repo/shared-types";
import type { GenerateTextResult } from "./TextGenerationService";

export interface ChatStreamInput {
  messages: CoreMessage[];
  system?: string;
  tools?: Record<string, CoreTool>;
  model?: string;
  providerId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  onFinish?: (result: GenerateTextResult) => Promise<void> | void;
  onChunk?: (chunk: {
    content?: string;
    toolCall?: { toolName: string; args: unknown };
  }) => void;
}
