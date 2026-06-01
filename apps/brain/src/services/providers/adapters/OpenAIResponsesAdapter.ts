import { z } from "zod";
import type { CoreMessage } from "ai";
import type { LLMUsage } from "@shadowbox/execution-engine/runtime/cost";
import type {
  GenerationParams,
  GenerationResult,
  ProviderAdapter,
  StreamChunk,
} from "../base/ProviderAdapter";
import { ProviderError } from "../base/ProviderAdapter";

interface OpenAIResponsesConfig {
  apiKey: string;
  endpoint: string;
  providerId: string;
  defaultModel?: string;
}

const OPENAI_RESPONSES_TIMEOUT_MS = 150_000;

const ResponsesUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const ResponsesOutputContentSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

const ResponsesOutputItemSchema = z
  .object({
    type: z.string().optional(),
    name: z.string().optional(),
    arguments: z.union([z.string(), z.record(z.unknown())]).optional(),
    content: z.array(ResponsesOutputContentSchema).optional(),
  })
  .passthrough();

const ResponsesPayloadSchema = z
  .object({
    output_text: z.string().optional(),
    output: z.array(ResponsesOutputItemSchema).optional(),
    usage: ResponsesUsageSchema.optional(),
    status: z.string().optional(),
  })
  .passthrough();

type ResponsesPayload = z.infer<typeof ResponsesPayloadSchema>;
type ResponsesOutputItem = z.infer<typeof ResponsesOutputItemSchema>;

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly supportedModels: string[] = [];
  readonly provider: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly defaultModel?: string;

  constructor(config: OpenAIResponsesConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint;
    this.provider = config.providerId;
    this.defaultModel = config.defaultModel;
  }

  supportsModel(_model: string): boolean {
    return true;
  }

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const model = this.resolveModel(params.model);
    const payload = await requestResponsesCompletion({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      body: buildResponsesRequestBody(params, model),
    });
    const usage = normalizeResponsesUsage(payload.usage, this.provider, model);

    return {
      content: extractResponsesText(payload),
      usage,
      finishReason: payload.status,
      toolCalls: extractResponsesToolCalls(payload.output),
    };
  }

  async *generateStream(
    params: GenerationParams,
  ): AsyncGenerator<StreamChunk, GenerationResult, unknown> {
    const result = await this.generate(params);
    if (result.content) {
      yield {
        type: "text",
        content: result.content,
      };
    }
    yield {
      type: "finish",
      usage: result.usage,
      finishReason: result.finishReason,
    };
    return result;
  }

  private resolveModel(model: string | undefined): string {
    const resolvedModel = model ?? this.defaultModel;
    if (!resolvedModel) {
      throw new ProviderError(
        this.provider,
        "Model is required for OpenAI Responses transport.",
      );
    }
    return resolvedModel;
  }
}

async function requestResponsesCompletion(input: {
  endpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
}): Promise<ResponsesPayload> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    OPENAI_RESPONSES_TIMEOUT_MS,
  );
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new ProviderError(
        "openai-responses",
        `Responses request failed with status ${response.status}${await readErrorDetail(response)}`,
      );
    }
    return parseResponsesPayload(await response.json());
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    throw new ProviderError(
      "openai-responses",
      `Responses request failed: ${toErrorMessage(error)}`,
      error,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildResponsesRequestBody(
  params: GenerationParams,
  model: string,
): Record<string, unknown> {
  return {
    model,
    input: buildResponsesInput(params.messages, params.system),
    temperature: params.temperature,
  };
}

function buildResponsesInput(
  messages: CoreMessage[],
  system: string | undefined,
): Array<Record<string, string>> {
  const systemMessages = system
    ? [
        {
          role: "system",
          content: system,
        },
      ]
    : [];
  return [...systemMessages, ...messages.map(toResponsesMessage)];
}

function toResponsesMessage(message: CoreMessage): Record<string, string> {
  return {
    role: message.role,
    content: stringifyCoreMessageContent(message.content),
  };
}

function stringifyCoreMessageContent(content: CoreMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}

function parseResponsesPayload(payload: unknown): ResponsesPayload {
  const parsed = ResponsesPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderError(
      "openai-responses",
      "Responses payload failed schema validation.",
      parsed.error,
    );
  }
  return parsed.data;
}

function extractResponsesText(payload: ResponsesPayload): string {
  if (payload.output_text) {
    return payload.output_text;
  }
  return (
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string")
      .join("") ?? ""
  );
}

function extractResponsesToolCalls(
  output: ResponsesOutputItem[] | undefined,
): GenerationResult["toolCalls"] {
  const toolCalls = output
    ?.filter((item) => item.type === "function_call" && item.name)
    .map((item) => ({
      toolName: item.name ?? "",
      args: parseToolArguments(item.arguments),
    }));
  return toolCalls && toolCalls.length > 0 ? toolCalls : undefined;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function normalizeResponsesUsage(
  usage: ResponsesPayload["usage"],
  provider: string,
  model: string,
): LLMUsage {
  const promptTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const completionTokens =
    usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  return {
    provider,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    raw: usage,
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as {
      error?: { message?: string };
    };
    return payload.error?.message ? ` - ${payload.error.message}` : "";
  } catch {
    return "";
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown_error";
}
