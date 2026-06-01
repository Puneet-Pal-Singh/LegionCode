import type { CoreMessage, CoreTool } from "ai";
import type { ProviderModelTransport } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import type { ProviderAdapter, ProviderConfigService } from "../providers";
import type { ModelSelection } from "./ModelSelectionPolicy";
import { consumeAxisQuotaIfNeeded } from "./axis-quota";
import { normalizeFinishCallback } from "./normalize-finish-callback";
import { buildProviderTransportRoute } from "./ProviderRouteMetadata";
import {
  createChatStream,
  generateText,
  selectAdapter,
  type GenerateTextResult,
} from "./index";

interface ProviderGenerationInput {
  selection: ModelSelection;
  defaultAdapter: ProviderAdapter;
  env: Env;
  providerConfigService?: ProviderConfigService;
  providerId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
}

interface TextGenerationInput extends ProviderGenerationInput {
  messages: CoreMessage[];
  system?: string;
  tools?: Record<string, CoreTool>;
  temperature: number;
}

interface ChatStreamInput extends TextGenerationInput {
  onFinish?: (result: GenerateTextResult) => Promise<void> | void;
  onChunk?: (chunk: {
    content?: string;
    toolCall?: { toolName: string; args: unknown };
  }) => void;
}

export async function generateTextWithSelection(
  input: TextGenerationInput,
): Promise<GenerateTextResult> {
  const selectedAdapter = await selectProviderAdapter(input);
  const result = await generateText(selectedAdapter, {
    messages: input.messages,
    system: input.system,
    tools: input.tools,
    temperature: input.temperature,
    model: input.runtimeModelId ?? input.selection.model,
  });
  return normalizeUsageProvider(result, input.providerId);
}

export async function createChatStreamWithSelection(
  input: ChatStreamInput,
): Promise<ReadableStream<Uint8Array>> {
  const selectedAdapter = await selectProviderAdapter(input);
  return createChatStream(
    selectedAdapter,
    {
      messages: input.messages,
      system: input.system,
      tools: input.tools,
      temperature: input.temperature,
      model: input.runtimeModelId ?? input.selection.model,
    },
    {
      onFinish: normalizeFinishCallback(input.providerId, input.onFinish),
      onChunk: input.onChunk,
    },
  );
}

async function selectProviderAdapter(
  input: ProviderGenerationInput,
): Promise<ProviderAdapter> {
  await consumeAxisQuotaIfNeeded(
    input.selection.providerId,
    input.providerConfigService,
  );
  return selectAdapter(
    input.selection,
    input.defaultAdapter,
    input.env,
    input.providerConfigService,
    undefined,
    buildProviderTransportRoute({
      providerId: input.selection.providerId,
      providerTransport: input.providerTransport,
      providerEndpoint: input.providerEndpoint,
    }),
  );
}

function normalizeUsageProvider(
  result: GenerateTextResult,
  providerId: string | undefined,
): GenerateTextResult {
  if (!providerId || result.usage.provider === providerId) {
    return result;
  }
  return {
    ...result,
    usage: {
      ...result.usage,
      provider: providerId,
    },
  };
}
