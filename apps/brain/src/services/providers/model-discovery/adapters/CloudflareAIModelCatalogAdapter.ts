import { z } from "zod";
import type {
  BYOKDiscoveredProviderModel,
  CloudflareAIConnectionConfig,
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
import { buildCloudflareAIRoute } from "../../cloudflare/CloudflareAIRouteBuilder";

const CLOUDFLARE_AI_PROVIDER_ID = "cloudflare-ai";
const CLOUDFLARE_AI_FETCH_TIMEOUT_MS = 15_000;

const CloudflareModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    task: z.string().optional(),
    context_window: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
  })
  .passthrough();

const CloudflareModelsSchema = z.object({
  success: z.boolean().optional(),
  result: z.array(CloudflareModelSchema),
});

type CloudflareModelPayload = z.infer<typeof CloudflareModelSchema>;

export class CloudflareAIModelCatalogAdapter implements ProviderModelCatalogPort {
  async fetchAll(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== CLOUDFLARE_AI_PROVIDER_ID) {
      throw new ProviderModelDiscoveryApiError(
        `Cloudflare AI adapter received unsupported provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }
    const config = resolveCloudflareConfig(credentialContext.connectionConfig);
    const response = await requestCloudflareModels({
      apiKey: credentialContext.apiKey,
      accountId: config.accountId,
    });
    const models = await parseCloudflareModels(response);
    return models.map((model) => normalizeCloudflareModel(model, config));
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

function resolveCloudflareConfig(
  config: ProviderModelCredentialContext["connectionConfig"],
): CloudflareAIConnectionConfig {
  if (config?.providerId === CLOUDFLARE_AI_PROVIDER_ID) {
    return config;
  }
  throw new ProviderModelDiscoveryApiError(
    "Cloudflare AI model discovery requires account connection config.",
    { status: 400, retryable: false },
  );
}

async function requestCloudflareModels(input: {
  apiKey: string;
  accountId: string;
}): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    CLOUDFLARE_AI_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/ai/models/search?task=Text%20Generation`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
        },
        signal: abortController.signal,
      },
    );
    if (!response.ok) {
      throw await toProviderApiError(response);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderModelDiscoveryApiError) {
      throw error;
    }
    throw new ProviderModelDiscoveryApiError(
      `Cloudflare AI models request failed: ${toErrorMessage(error)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseCloudflareModels(
  response: Response,
): Promise<CloudflareModelPayload[]> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderModelDiscoveryApiError(
      `Cloudflare AI models response body was not valid JSON: ${toErrorMessage(error)}`,
      { retryable: false },
    );
  }
  const parsed = CloudflareModelsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderModelNormalizationError(
      "Cloudflare AI models response failed schema validation.",
    );
  }
  return parsed.data.result.filter(isTextGenerationModel);
}

function normalizeCloudflareModel(
  model: CloudflareModelPayload,
  config: CloudflareAIConnectionConfig,
): BYOKDiscoveredProviderModel {
  const endpoint = buildCloudflareAIRoute({
    config,
    modelId: model.id,
    transport: "openai-chat-completions",
  });
  return {
    id: model.id,
    name: model.name ?? model.id,
    providerId: CLOUDFLARE_AI_PROVIDER_ID,
    description: model.description,
    contextWindow: model.contextWindow ?? model.context_window,
    capabilities: {
      supportsTools: true,
      supportsStructuredOutputs: true,
    },
    runtimeRoute: {
      providerId: CLOUDFLARE_AI_PROVIDER_ID,
      modelId: model.id,
      transport: "openai-chat-completions",
      endpoint,
    },
    availability: "available",
  };
}

function isTextGenerationModel(model: CloudflareModelPayload): boolean {
  const task = model.task?.trim().toLowerCase();
  return !task || task.includes("text") || task.includes("chat");
}

async function toProviderApiError(
  response: Response,
): Promise<ProviderModelDiscoveryApiError> {
  const isAuthError = response.status === 401 || response.status === 403;
  return new ProviderModelDiscoveryApiError(
    `Cloudflare AI models request failed with status ${response.status}${await readProviderErrorDetail(response)}`,
    {
      status: response.status,
      retryable: response.status >= 500 && !isAuthError,
    },
  );
}

async function readProviderErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as {
      errors?: Array<{ message?: string }>;
    };
    const message = payload.errors?.find((error) => error.message)?.message;
    return message ? ` - ${message}` : "";
  } catch {
    return "";
  }
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
