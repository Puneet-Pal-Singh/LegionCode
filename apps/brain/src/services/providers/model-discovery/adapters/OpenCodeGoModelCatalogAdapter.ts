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

const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const OPENCODE_GO_MODELS_ENDPOINT = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_GO_CHAT_ENDPOINT =
  "https://opencode.ai/zen/go/v1/chat/completions";
const OPENCODE_GO_MESSAGES_ENDPOINT = "https://opencode.ai/zen/go/v1/messages";
const OPENCODE_GO_FETCH_TIMEOUT_MS = 15_000;

const CHAT_COMPLETIONS_MODEL_IDS = new Set([
  "glm-5.1",
  "glm-5",
  "kimi-k2.5",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
]);

const MESSAGES_MODEL_IDS = new Set([
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.6-plus",
  "qwen3.5-plus",
]);

const OpenCodeGoModelsSchema = z.union([
  z.object({
    data: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          context_window: z.number().int().positive().optional(),
          contextWindow: z.number().int().positive().optional(),
        })
        .passthrough(),
    ),
  }),
  z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        context_window: z.number().int().positive().optional(),
        contextWindow: z.number().int().positive().optional(),
      })
      .passthrough(),
  ),
]);

type OpenCodeGoModelPayload = {
  id: string;
  name?: string;
  description?: string;
  context_window?: number;
  contextWindow?: number;
};

export class OpenCodeGoModelCatalogAdapter implements ProviderModelCatalogPort {
  async fetchAll(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== OPENCODE_GO_PROVIDER_ID) {
      throw new ProviderModelDiscoveryApiError(
        `OpenCode Go adapter received unsupported provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }

    const response = await requestOpenCodeGoModels(credentialContext.apiKey);
    const models = await parseOpenCodeGoModels(response);
    return models.map(normalizeOpenCodeGoModel);
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

async function requestOpenCodeGoModels(apiKey: string): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    OPENCODE_GO_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(OPENCODE_GO_MODELS_ENDPOINT, {
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
        "OpenCode Go models request timed out.",
        { status: 504, retryable: true },
      );
    }
    throw new ProviderModelDiscoveryApiError(
      `OpenCode Go models request failed due to network error: ${toErrorMessage(error)}`,
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
    `OpenCode Go models request failed with status ${response.status}${detail}`,
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

async function parseOpenCodeGoModels(
  response: Response,
): Promise<OpenCodeGoModelPayload[]> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderModelDiscoveryApiError(
      `OpenCode Go models response body was not valid JSON: ${toErrorMessage(error)}`,
      { retryable: false },
    );
  }

  const parsed = OpenCodeGoModelsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderModelNormalizationError(
      "OpenCode Go models response failed schema validation.",
    );
  }

  return Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
}

function normalizeOpenCodeGoModel(
  model: OpenCodeGoModelPayload,
): BYOKDiscoveredProviderModel {
  const route = resolveOpenCodeGoRoute(model.id);
  return {
    id: model.id,
    name: model.name ?? model.id,
    providerId: OPENCODE_GO_PROVIDER_ID,
    description: model.description,
    contextWindow: model.contextWindow ?? model.context_window,
    capabilities: {
      supportsTools: true,
      supportsStructuredOutputs: route.transport === "openai-chat-completions",
    },
    runtimeRoute: {
      providerId: OPENCODE_GO_PROVIDER_ID,
      modelId: model.id,
      transport: route.transport,
      endpoint: route.endpoint,
    },
    availability: route.available ? "available" : "unsupported_transport",
    unavailableReason: route.available
      ? undefined
      : "Anthropic Messages transport is not wired yet.",
  };
}

function resolveOpenCodeGoRoute(modelId: string): {
  transport: ProviderModelTransport;
  endpoint: string;
  available: boolean;
} {
  if (CHAT_COMPLETIONS_MODEL_IDS.has(modelId)) {
    return {
      transport: "openai-chat-completions",
      endpoint: OPENCODE_GO_CHAT_ENDPOINT,
      available: true,
    };
  }
  if (MESSAGES_MODEL_IDS.has(modelId)) {
    return {
      transport: "anthropic-messages",
      endpoint: OPENCODE_GO_MESSAGES_ENDPOINT,
      available: false,
    };
  }
  return {
    transport: "openai-chat-completions",
    endpoint: OPENCODE_GO_CHAT_ENDPOINT,
    available: false,
  };
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
