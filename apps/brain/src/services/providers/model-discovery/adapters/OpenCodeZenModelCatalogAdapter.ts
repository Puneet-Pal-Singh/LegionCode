import { z } from "zod";
import type {
  BYOKDiscoveredProviderModel,
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
const OPENCODE_ZEN_FETCH_TIMEOUT_MS = 15_000;

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
  return {
    id: model.id,
    name: model.name ?? model.id,
    providerId: OPENCODE_ZEN_PROVIDER_ID,
    description: model.description,
    contextWindow: model.contextWindow ?? model.context_window,
    availability: "unsupported_transport",
    unavailableReason:
      "OpenCode model transport metadata is unavailable from the live model-list response.",
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
