import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CoreMessage, CoreTool } from "ai";
import type { LLMUsage } from "../../cost/types.js";
import type {
  GenerationParams,
  GenerationResult,
  ProviderAdapter,
  StreamChunk,
} from "../base/ProviderAdapter.js";
import { ProviderError } from "../base/ProviderAdapter.js";

interface OpenAIResponsesConfig {
  apiKey: string;
  endpoint: string;
  providerId: string;
  defaultModel?: string;
}

const OPENAI_RESPONSES_TIMEOUT_MS = 150_000;
// Bound a single unfinished SSE event independently of the request timeout.
const MAX_RESPONSES_EVENT_CHARS = 16 * 1024 * 1024;

// The converter validates its own schema input; keep the package boundary free
// of recursively expanding Zod types from different supported entry points.
const convertToolSchema = zodToJsonSchema as unknown as (
  schema: unknown,
  options: { $refStrategy: "none" },
) => unknown;

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

const ResponsesReasoningSummarySchema = z
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
    summary: z.array(ResponsesReasoningSummarySchema).optional(),
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
  strict: false;
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
      transcriptParts: extractResponsesReasoningSummary(payload.output),
    };
  }

  async *generateStream(
    params: GenerationParams,
  ): AsyncGenerator<StreamChunk, GenerationResult, unknown> {
    const model = this.resolveModel(params.model);
    const controller = new AbortController();
    const abort = () => controller.abort(params.signal?.reason);
    params.signal?.addEventListener("abort", abort, { once: true });
    if (params.signal?.aborted) abort();
    const timeout = setTimeout(
      () => controller.abort(),
      OPENAI_RESPONSES_TIMEOUT_MS,
    );
    try {
      if (controller.signal.aborted) throw new Error("aborted");
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...buildResponsesRequestBody(params, model),
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProviderError(
          "openai-responses",
          `Responses request failed with status ${response.status}`,
          undefined,
          {
            statusCode: response.status,
            retryable:
              response.status === 408 ||
              response.status === 429 ||
              response.status >= 500,
          },
        );
      }
      if (
        !response.body ||
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "text/event-stream"
      ) {
        throw invalidResponsesStream();
      }
      let content = "";
      let result: GenerationResult | undefined;
      const calls = new Map<
        string,
        NonNullable<GenerationResult["toolCalls"]>[number]
      >();
      for await (const event of readResponsesEvents(
        response.body,
        controller.signal,
      )) {
        if (controller.signal.aborted) throw new Error("aborted");
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string") throw invalidResponsesStream();
          content += event.delta;
          yield { type: "text", content: event.delta };
        } else if (event.type === "response.output_item.done") {
          const parsed = ResponsesOutputItemSchema.safeParse(event.item);
          if (!parsed.success) throw invalidResponsesStream();
          const item = parsed.data;
          if (item.type !== "function_call") continue;
          const call = completeStreamToolCall(item);
          const previous = calls.get(call.toolCallId!);
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(call))
              throw invalidResponsesStream();
            continue;
          }
          calls.set(call.toolCallId!, call);
          yield { type: "tool-call", toolCall: call };
        } else if (event.type === "response.completed") {
          const parsed = ResponsesPayloadSchema.safeParse(event.response);
          if (!parsed.success) throw invalidResponsesStream();
          const payload = parsed.data;
          if (
            payload.status !== "completed" ||
            !payload.output ||
            extractResponsesText(payload) !== content
          ) {
            throw invalidResponsesStream();
          }
          const finalCalls = payload.output
            .filter((item) => item.type === "function_call")
            .map(completeStreamToolCall);
          if (
            finalCalls.length !== calls.size ||
            finalCalls.some(
              (call) =>
                JSON.stringify(calls.get(call.toolCallId!)) !==
                JSON.stringify(call),
            )
          ) {
            throw invalidResponsesStream();
          }
          result = {
            content,
            usage: normalizeResponsesUsage(payload.usage, this.provider, model),
            finishReason: payload.status,
            toolCalls: finalCalls.length ? finalCalls : undefined,
            transcriptParts: extractResponsesReasoningSummary(payload.output),
          };
          break;
        } else if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "error"
        ) {
          throw new ProviderError(
            "openai-responses",
            "Responses stream did not complete successfully",
            undefined,
            {
              code: "PROVIDER_UNAVAILABLE",
              statusCode: 502,
              retryable: event.type !== "response.incomplete",
            },
          );
        }
      }
      if (controller.signal.aborted) throw new Error("aborted");
      if (!result) throw invalidResponsesStream();
      yield {
        type: "finish",
        usage: result.usage,
        finishReason: result.finishReason,
      };
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const interrupted = params.signal?.aborted === true;
      const timedOut = controller.signal.aborted && !interrupted;
      throw new ProviderError(
        "openai-responses",
        "Responses stream failed",
        undefined,
        {
          code: interrupted
            ? "ABORTED"
            : timedOut
              ? "TIMEOUT"
              : "NETWORK_ERROR",
          statusCode: timedOut ? 408 : undefined,
          retryable: !interrupted,
        },
      );
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
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

function invalidResponsesStream(): ProviderError {
  return new ProviderError(
    "openai-responses",
    "Responses stream failed contract validation",
    undefined,
    {
      code: "INVALID_RESPONSE_CONTRACT",
      statusCode: 502,
      retryable: false,
    },
  );
}

function completeStreamToolCall(
  item: ResponsesOutputItem,
): NonNullable<GenerationResult["toolCalls"]>[number] {
  if (
    item.status !== "completed" ||
    !item.call_id ||
    !item.name ||
    typeof item.arguments !== "string"
  ) {
    throw invalidResponsesStream();
  }
  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    throw invalidResponsesStream();
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw invalidResponsesStream();
  return { toolCallId: item.call_id, toolName: item.name, args };
}

/** SSE framing is independent of fetch chunks, including split UTF-8 and CRLF. */
async function* readResponsesEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let dataLength = 0;
  let eventName = "";
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      try {
        buffer += decoder.decode(value, { stream: !done });
      } catch {
        throw invalidResponsesStream();
      }
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (signal.aborted) throw new Error("aborted");
        // A trailing CR may be the first half of a CRLF in the next fetch chunk.
        if (!done && match[0] === "\r" && match.index === buffer.length - 1)
          break;
        if (match.index > MAX_RESPONSES_EVENT_CHARS)
          throw invalidResponsesStream();
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === "") {
          if (data.length) {
            let event: unknown;
            try {
              event = JSON.parse(data.join("\n"));
            } catch {
              throw invalidResponsesStream();
            }
            if (
              !event ||
              typeof event !== "object" ||
              Array.isArray(event) ||
              typeof (event as Record<string, unknown>).type !== "string" ||
              (eventName &&
                eventName !== (event as Record<string, unknown>).type)
            )
              throw invalidResponsesStream();
            data = [];
            dataLength = 0;
            eventName = "";
            yield event as Record<string, unknown>;
          }
          eventName = "";
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const raw = colon < 0 ? "" : line.slice(colon + 1);
          const value = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (field === "data") {
            dataLength += value.length + 1;
            if (dataLength > MAX_RESPONSES_EVENT_CHARS)
              throw invalidResponsesStream();
            data.push(value);
          } else if (field === "event") eventName = value;
        }
      }
      if (buffer.length > MAX_RESPONSES_EVENT_CHARS)
        throw invalidResponsesStream();
      if (done) {
        if (buffer || data.length || eventName) throw invalidResponsesStream();
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function requestResponsesCompletion(input: {
  endpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ResponsesPayload> {
  if (input.signal?.aborted) {
    throw new ProviderError(
      "openai-responses",
      "Responses request was aborted",
      undefined,
      { code: "ABORTED", retryable: false },
    );
  }
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
        undefined,
        {
          statusCode: response.status,
          retryable:
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (abortController.signal.aborted) throw error;
      throw new ProviderError(
        "openai-responses",
        "Responses payload is not valid JSON",
        undefined,
        {
          code: "INVALID_RESPONSE_CONTRACT",
          statusCode: 502,
          retryable: false,
        },
      );
    }
    return parseResponsesPayload(payload);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    const interrupted = input.signal?.aborted === true;
    const timedOut = abortController.signal.aborted && !interrupted;
    throw new ProviderError(
      "openai-responses",
      `Responses request failed: ${toErrorMessage(error)}`,
      error,
      {
        code: interrupted ? "ABORTED" : timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        statusCode: timedOut ? 408 : undefined,
        retryable: !interrupted,
      },
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
    body.reasoning = { effort: params.reasoningEffort, summary: "auto" };
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

  const inputContent = message.content.flatMap(toResponsesUserContentPart);
  return [
    {
      role: message.role,
      content: inputContent.length > 0 ? inputContent : " ",
    },
  ];
}

function toResponsesUserContentPart(
  value: unknown,
): Array<Record<string, unknown>> {
  if (isTextPart(value)) {
    return value.text.length > 0
      ? [{ type: "input_text", text: value.text }]
      : [];
  }
  if (isImagePart(value)) {
    return [
      {
        type: "input_image",
        image_url: value.image,
        detail: "auto",
      },
    ];
  }
  return [];
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
      { code: "INVALID_RESPONSE_CONTRACT", statusCode: 502, retryable: false },
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
      ?.filter((item) => item.type === "message")
      ?.flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text")
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

function extractResponsesReasoningSummary(
  output: ResponsesOutputItem[] | undefined,
): GenerationResult["transcriptParts"] {
  const text = output
    ?.filter((item) => item.type === "reasoning")
    .flatMap((item) => item.summary ?? [])
    .filter((part) => part.type === "summary_text")
    .map((part) => part.text?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  return text ? [{ type: "reasoning", text, displaySafe: true }] : undefined;
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
        strict: false,
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
    const schema = convertToolSchema(value, {
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

function isImagePart(
  value: unknown,
): value is { type: "image"; image: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { image?: unknown }).image === "string"
  );
}

function isToolCallPart(value: unknown): value is {
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

function isToolResultPart(value: unknown): value is {
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
