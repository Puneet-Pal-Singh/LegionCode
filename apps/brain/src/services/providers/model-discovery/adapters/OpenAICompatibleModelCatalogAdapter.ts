import { z } from "zod";
import type {
  BYOKDiscoveredProviderModel,
  ReasoningEffort,
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

const OpenAICompatibleModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
    }),
  ),
});
const OPENAI_COMPATIBLE_FETCH_TIMEOUT_MS = 15_000;

export class OpenAICompatibleModelCatalogAdapter implements ProviderModelCatalogPort {
  constructor(
    private readonly providerId: string,
    private readonly modelsEndpoint: string,
  ) {}

  async fetchAll(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== this.providerId) {
      throw new ProviderModelDiscoveryApiError(
        `Adapter for "${this.providerId}" received unsupported provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }
    const response = await requestOpenAICompatibleModels(
      this.providerId,
      this.modelsEndpoint,
      credentialContext.apiKey,
    );
    const payload = await parseOpenAICompatibleModels(
      response,
      this.providerId,
    );
    return payload.data.map((item) =>
      toDiscoveredModel(this.providerId, item.id),
    );
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

function toDiscoveredModel(
  providerId: string,
  modelId: string,
): BYOKDiscoveredProviderModel {
  const reasoningEfforts =
    providerId === "openai" ? resolveOpenAIReasoningEfforts(modelId) : [];
  return {
    id: modelId,
    name: modelId,
    providerId,
    ...(reasoningEfforts.length > 0
      ? {
          capabilities: {
            supportsReasoning: true,
            reasoningEfforts,
          },
          capabilityMetadata: {
            source: "static_override" as const,
            confidence: "declared" as const,
          },
        }
      : {}),
  };
}

export function resolveOpenAIReasoningEfforts(
  modelId: string,
): ReasoningEffort[] {
  const normalized = modelId.trim().toLowerCase();
  if (/^gpt-5(?:\.[0-9]+)?-pro(?:[.-]|$)/.test(normalized)) {
    return ["high"];
  }
  if (/^gpt-5\.1(?:[.-]|$)/.test(normalized)) {
    return ["none", "low", "medium", "high"];
  }
  if (/^gpt-5\.6(?:[.-]|$)/.test(normalized)) {
    return ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  if (/^gpt-5(?:[.-]|$)/.test(normalized)) {
    return ["none", "minimal", "low", "medium", "high", "xhigh"];
  }
  if (/^o[1-9](?:[.-]|$)/.test(normalized)) {
    return ["low", "medium", "high"];
  }
  return [];
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

async function requestOpenAICompatibleModels(
  providerId: string,
  modelsEndpoint: string,
  apiKey: string,
): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    OPENAI_COMPATIBLE_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(modelsEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (isAbortError(error)) {
      throw new ProviderModelDiscoveryApiError(
        `${providerId} models request timed out.`,
        { status: 504, retryable: true },
      );
    }
    throw new ProviderModelDiscoveryApiError(
      `${providerId} models request failed due to network error: ${toErrorMessage(error)}`,
      { retryable: true },
    );
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorBody = (await response.clone().json()) as
        | {
            error?: { message?: string };
          }
        | undefined;
      if (errorBody?.error?.message) {
        errorDetail = ` - ${errorBody.error.message}`;
      }
    } catch {
      /* ignore parse errors */
    }
    const isAuthError = response.status === 401 || response.status === 403;
    throw new ProviderModelDiscoveryApiError(
      `${providerId} models request failed with status ${response.status}${errorDetail}`,
      {
        status: response.status,
        retryable: response.status >= 500 && !isAuthError,
      },
    );
  }
  return response;
}

async function parseOpenAICompatibleModels(
  response: Response,
  providerId: string,
): Promise<z.infer<typeof OpenAICompatibleModelsSchema>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderModelDiscoveryApiError(
      `${providerId} models response body was not valid JSON: ${toErrorMessage(error)}`,
      { retryable: false },
    );
  }

  const parsed = OpenAICompatibleModelsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderModelNormalizationError(
      `${providerId} models response failed schema validation.`,
    );
  }
  return parsed.data;
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
