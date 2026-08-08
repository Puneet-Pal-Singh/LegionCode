import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import type { CoreMessage, CoreTool } from "ai";
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
    id: z.string().optional(),
    call_id: z.string().optional(),
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
type ResponsesToolDefinition = {
  type: string;
  name: string;
  description: string | undefined;
  parameters: Record<string, unknown>;
};

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
      signal: params.signal,
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
    for (const toolCall of result.toolCalls ?? []) {
      yield {
        type: "tool-call",
        toolCall,
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
  signal?: AbortSignal;
}): Promise<ResponsesPayload> {
  const abortController = new AbortController();
  const abort = () => abortController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
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
    input.signal?.removeEventListener("abort", abort);
  }
}

function buildResponsesRequestBody(
  params: GenerationParams,
  model: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: buildResponsesInput(params.messages, params.system),
    max_output_tokens: params.maxOutputTokens ?? 4096,
  };
  const tools = buildResponsesTools(params.tools);
  if (tools) {
    body.tools = tools;
  }
  if (params.reasoningEffort) {
    body.reasoning = { effort: params.reasoningEffort };
  }
  return body;
}

function buildResponsesInput(
  messages: CoreMessage[],
  system: string | undefined,
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  if (system) {
    input.push({ role: "system", content: system });
  }
  for (const message of messages) {
    input.push(...toResponsesInputItems(message));
  }
  return input;
}

function toResponsesInputItems(
  message: CoreMessage,
): Array<Record<string, unknown>> {
  if (typeof message.content === "string") {
    return [
      {
        role: message.role,
        content: message.content,
      },
    ];
  }

  if (!Array.isArray(message.content)) {
    return [
      {
        role: message.role,
        content: stringifyCoreMessageContent(message.content),
      },
    ];
  }

  if (message.role === "assistant") {
    const items: Array<Record<string, unknown>> = [];
    const text = message.content
      .flatMap((part) =>
        isTextPart(part) && part.text.trim().length > 0 ? [part.text] : [],
      )
      .join("\n")
      .trim();
    if (text) {
      items.push({ role: "assistant", content: text });
    }
    for (const part of message.content) {
      if (!isToolCallPart(part)) {
        continue;
      }
      items.push({
        type: "function_call",
        call_id: part.toolCallId,
        name: part.toolName,
        arguments: JSON.stringify(part.args ?? {}),
      });
    }
    return items.length > 0 ? items : [{ role: "assistant", content: " " }];
  }

  if (message.role === "tool") {
    return message.content.flatMap((part) => {
      if (!isToolResultPart(part)) {
        return [];
      }
      return [
        {
          type: "function_call_output",
          call_id: part.toolCallId,
          output: stringifyToolResult(part.result),
        },
      ];
    });
  }

  return [
    {
      role: message.role,
      content: stringifyCoreMessageContent(message.content),
    },
  ];
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
      toolCallId: item.call_id ?? item.id,
      toolName: item.name ?? "",
      args: parseToolArguments(item.arguments),
    }));
  return toolCalls && toolCalls.length > 0 ? toolCalls : undefined;
}

function buildResponsesTools(
  tools: Record<string, CoreTool> | undefined,
): ResponsesToolDefinition[] | undefined {
  if (!tools) {
    return undefined;
  }

  const entries = Object.entries(tools)
    .map(([name, tool]) => {
      const parameters = readToolParameters(tool);
      if (!parameters) {
        return null;
      }
      return {
        type: "function",
        name,
        description: readToolDescription(tool),
        parameters,
      };
    })
    .filter((entry): entry is ResponsesToolDefinition => entry !== null);

  return entries.length > 0 ? entries : undefined;
}

function readToolParameters(tool: CoreTool): Record<string, unknown> | null {
  const record = tool as Record<string, unknown>;
  return (
    readJsonSchemaRecord(record.parameters) ??
    readJsonSchemaRecord(record.inputSchema)
  );
}

function readJsonSchemaRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.safeParse === "function" && "_def" in record) {
    const schema = zodToJsonSchema(value as z.ZodTypeAny, {
      $refStrategy: "none",
    });
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return null;
    }
    const { $schema: _schema, ...jsonSchema } = schema as Record<
      string,
      unknown
    >;
    return jsonSchema;
  }
  return record;
}

function readToolDescription(tool: CoreTool): string | undefined {
  const description = (tool as Record<string, unknown>).description;
  return typeof description === "string" && description.trim()
    ? description.trim()
    : undefined;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isToolCallPart(
  value: unknown,
): value is {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "tool-call" &&
    typeof (value as { toolCallId?: unknown }).toolCallId === "string" &&
    typeof (value as { toolName?: unknown }).toolName === "string"
  );
}

function isToolResultPart(
  value: unknown,
): value is {
  type: "tool-result";
  toolCallId: string;
  result: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "tool-result" &&
    typeof (value as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? null);
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
