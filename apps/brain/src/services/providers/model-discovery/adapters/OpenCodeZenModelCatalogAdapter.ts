import { z } from "zod";
import type {
  BYOKDiscoveredProviderModel,
  ProviderModelTransport,
} from "@repo/shared-types";
import type { ProviderModelCatalogPort } from "../ProviderModelCatalogPort";
import type {
  ProviderModelCredentialContext,
  ProviderModelFetchPageInput,
  ProviderModelPageFetchResult,
} from "../types";
import {
  ProviderModelDiscoveryApiError,
  ProviderModelNormalizationError,
} from "../errors";

const OPENCODE_ZEN_PROVIDER_ID = "opencode-zen";
const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
const OPENCODE_ZEN_RESPONSES_ENDPOINT = "https://opencode.ai/zen/v1/responses";
const OPENCODE_ZEN_MESSAGES_ENDPOINT = "https://opencode.ai/zen/v1/messages";
const OPENCODE_ZEN_CHAT_ENDPOINT =
  "https://opencode.ai/zen/v1/chat/completions";
const OPENCODE_ZEN_FETCH_TIMEOUT_MS = 15_000;

const RESPONSES_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
]);

const MESSAGES_MODEL_IDS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "claude-3-5-haiku",
  "qwen3.6-plus",
  "qwen3.5-plus",
]);

const GOOGLE_MODEL_IDS = new Set([
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
]);

const CHAT_COMPLETIONS_MODEL_IDS = new Set([
  "minimax-m2.7",
  "minimax-m2.5",
  "glm-5.1",
  "glm-5",
  "kimi-k2.5",
  "kimi-k2.6",
  "grok-build-0.1",
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "nemotron-3-super-free",
]);

const OpenCodeZenModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    context_window: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    endpoint: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    api: z.string().min(1).optional(),
    transport: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    package: z.string().min(1).optional(),
  })
  .passthrough();

const OpenCodeZenModelsSchema = z.union([
  z.object({
    data: z.array(OpenCodeZenModelSchema),
  }),
  z.array(OpenCodeZenModelSchema),
]);

type OpenCodeZenModelPayload = z.infer<typeof OpenCodeZenModelSchema>;

type OpenCodeZenRoute = {
  transport: ProviderModelTransport;
  endpoint: string;
  available: boolean;
  unavailableReason?: string;
};

export class OpenCodeZenModelCatalogAdapter implements ProviderModelCatalogPort {
  async fetchAll(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    assertOpenCodeZenProvider(providerId);

    const response = await requestOpenCodeZenModels(credentialContext.apiKey);
    const models = await parseOpenCodeZenModels(response);
    return models.map(normalizeOpenCodeZenModel);
  }

  async fetchPage(
    input: ProviderModelFetchPageInput,
  ): Promise<ProviderModelPageFetchResult> {
    const offset = parseCursor(input.cursor);
    const models = await this.fetchAll(
      input.providerId,
      input.credentialContext,
    );
    const nextOffset = offset + input.limit;
    return {
      providerId: input.providerId,
      models: models.slice(offset, nextOffset),
      nextCursor: nextOffset < models.length ? String(nextOffset) : undefined,
      fetchedAt: new Date().toISOString(),
      source: "provider_api",
    };
  }
}

function assertOpenCodeZenProvider(providerId: string): void {
  if (providerId === OPENCODE_ZEN_PROVIDER_ID) {
    return;
  }
  throw new ProviderModelDiscoveryApiError(
    `OpenCode Zen adapter received unsupported provider "${providerId}".`,
    { status: 400, retryable: false },
  );
}

async function requestOpenCodeZenModels(apiKey: string): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    OPENCODE_ZEN_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(OPENCODE_ZEN_MODELS_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw await toProviderApiError(response);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderModelDiscoveryApiError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new ProviderModelDiscoveryApiError(
        "OpenCode Zen models request timed out.",
        { status: 504, retryable: true },
      );
    }
    throw new ProviderModelDiscoveryApiError(
      `OpenCode Zen models request failed due to network error: ${toErrorMessage(error)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function toProviderApiError(
  response: Response,
): Promise<ProviderModelDiscoveryApiError> {
  const isAuthError = response.status === 401 || response.status === 403;
  const detail = await readProviderErrorDetail(response);
  return new ProviderModelDiscoveryApiError(
    `OpenCode Zen models request failed with status ${response.status}${detail}`,
    {
      status: response.status,
      retryable: response.status >= 500 && !isAuthError,
    },
  );
}

async function readProviderErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as {
      error?: { message?: string };
    };
    return payload.error?.message ? ` - ${payload.error.message}` : "";
  } catch {
    return "";
  }
}

async function parseOpenCodeZenModels(
  response: Response,
): Promise<OpenCodeZenModelPayload[]> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderModelDiscoveryApiError(
      `OpenCode Zen models response body was not valid JSON: ${toErrorMessage(error)}`,
      { retryable: false },
    );
  }

  const parsed = OpenCodeZenModelsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderModelNormalizationError(
      "OpenCode Zen models response failed schema validation.",
    );
  }

  return Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
}

function normalizeOpenCodeZenModel(
  model: OpenCodeZenModelPayload,
): BYOKDiscoveredProviderModel {
  const route = resolveOpenCodeZenRoute(model);
  return {
    id: model.id,
    name: model.name ?? model.id,
    providerId: OPENCODE_ZEN_PROVIDER_ID,
    description: model.description,
    contextWindow: model.contextWindow ?? model.context_window,
    capabilities: buildCapabilities(route),
    runtimeRoute: {
      providerId: OPENCODE_ZEN_PROVIDER_ID,
      modelId: model.id,
      transport: route.transport,
      endpoint: route.endpoint,
    },
    availability: route.available ? "available" : "unsupported_transport",
    unavailableReason: route.unavailableReason,
  };
}

function buildCapabilities(
  route: OpenCodeZenRoute,
): BYOKDiscoveredProviderModel["capabilities"] {
  return {
    supportsTools: route.available,
    supportsStructuredOutputs:
      route.available && route.transport === "openai-chat-completions",
    supportsReasoning:
      route.available && route.transport === "openai-responses",
  };
}

function resolveOpenCodeZenRoute(
  model: OpenCodeZenModelPayload,
): OpenCodeZenRoute {
  const hintedRoute = resolveRouteFromMetadata(model);
  if (hintedRoute) {
    return hintedRoute;
  }
  return resolveRouteFromKnownModelId(model.id);
}

function resolveRouteFromMetadata(
  model: OpenCodeZenModelPayload,
): OpenCodeZenRoute | null {
  const hint = buildRouteHint(model);
  if (!hint) {
    return null;
  }
  if (hint.includes("chat/completions") || hint.includes("openai-compatible")) {
    return availableChatRoute();
  }
  if (hint.includes("responses")) {
    return unsupportedRoute(
      "openai-responses",
      OPENCODE_ZEN_RESPONSES_ENDPOINT,
      "OpenAI Responses transport is not wired yet.",
    );
  }
  if (hint.includes("messages") || hint.includes("anthropic")) {
    return unsupportedRoute(
      "anthropic-messages",
      OPENCODE_ZEN_MESSAGES_ENDPOINT,
      "Anthropic Messages transport is not wired yet.",
    );
  }
  if (hint.includes("google") || hint.includes("generative")) {
    return unsupportedRoute(
      "google-generative",
      toGoogleModelEndpoint(model.id),
      "Google Generative transport is not wired for OpenCode Zen yet.",
    );
  }
  return null;
}

function buildRouteHint(model: OpenCodeZenModelPayload): string {
  return [
    model.endpoint,
    model.path,
    model.url,
    model.api,
    model.transport,
    model.provider,
    model.package,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function resolveRouteFromKnownModelId(modelId: string): OpenCodeZenRoute {
  if (CHAT_COMPLETIONS_MODEL_IDS.has(modelId)) {
    return availableChatRoute();
  }
  if (RESPONSES_MODEL_IDS.has(modelId)) {
    return unsupportedRoute(
      "openai-responses",
      OPENCODE_ZEN_RESPONSES_ENDPOINT,
      "OpenAI Responses transport is not wired yet.",
    );
  }
  if (MESSAGES_MODEL_IDS.has(modelId)) {
    return unsupportedRoute(
      "anthropic-messages",
      OPENCODE_ZEN_MESSAGES_ENDPOINT,
      "Anthropic Messages transport is not wired yet.",
    );
  }
  if (GOOGLE_MODEL_IDS.has(modelId)) {
    return unsupportedRoute(
      "google-generative",
      toGoogleModelEndpoint(modelId),
      "Google Generative transport is not wired for OpenCode Zen yet.",
    );
  }
  return unsupportedRoute(
    "openai-chat-completions",
    OPENCODE_ZEN_CHAT_ENDPOINT,
    "OpenCode Zen model transport is not declared by provider metadata.",
  );
}

function availableChatRoute(): OpenCodeZenRoute {
  return {
    transport: "openai-chat-completions",
    endpoint: OPENCODE_ZEN_CHAT_ENDPOINT,
    available: true,
  };
}

function unsupportedRoute(
  transport: ProviderModelTransport,
  endpoint: string,
  unavailableReason: string,
): OpenCodeZenRoute {
  return {
    transport,
    endpoint,
    available: false,
    unavailableReason,
  };
}

function toGoogleModelEndpoint(modelId: string): string {
  return `${OPENCODE_ZEN_MODELS_ENDPOINT}/${encodeURIComponent(modelId)}`;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ProviderModelDiscoveryApiError(
      `Invalid pagination cursor "${cursor}".`,
      { status: 400, retryable: false },
    );
  }
  return parsed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown_error";
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}
