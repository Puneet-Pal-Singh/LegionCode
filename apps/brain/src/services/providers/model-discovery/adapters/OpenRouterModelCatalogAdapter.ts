import { z } from "zod";
import type {
  BYOKDiscoveredProviderModel,
  BYOKModelCapability,
  BYOKModelCapabilityMetadata,
  BYOKModelInputModality,
  BYOKModelOutputModality,
} from "@repo/shared-types";
import type { ProviderModelCatalogPort } from "../ProviderModelCatalogPort";
import type {
  ProviderModelCredentialContext,
  OpenRouterDiscoveryCategory,
  ProviderModelFetchPageInput,
  ProviderModelPageFetchResult,
} from "../types";
import {
  ProviderModelDiscoveryApiError,
  ProviderModelNormalizationError,
} from "../errors";

const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const OPENROUTER_USER_MODELS_ENDPOINT =
  "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_RANKINGS_PAGE_ENDPOINT = "https://openrouter.ai/rankings";
const OPENROUTER_FREE_ROUTER_PAGE_ENDPOINT =
  "https://openrouter.ai/openrouter/free";
const OPENROUTER_FETCH_TIMEOUT_MS = 30_000;
const OPENROUTER_MODEL_LINK_PATTERN = /href="\/([^"/?#]+\/[^"/?#]+)"/g;
const OPENROUTER_NON_MODEL_LINK_PREFIXES = new Set([
  "_next",
  "apps",
  "docs",
  "labs",
  "compare",
  "images",
  "settings",
]);

const OpenRouterModelsEnvelopeSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      slug: z.string().optional(),
      description: z.string().optional(),
      context_length: z.number().int().positive().optional(),
      pricing: z
        .object({
          prompt: z.string().optional(),
          completion: z.string().optional(),
        })
        .partial()
        .optional(),
      supported_parameters: z.array(z.string()).optional(),
      architecture: z
        .object({
          input_modalities: z.array(z.string()).optional(),
          modality: z.union([z.string(), z.array(z.string())]).optional(),
          output_modalities: z.array(z.string()).optional(),
        })
        .partial()
        .optional(),
      settings: z
        .object({
          structured_outputs: z.boolean().optional(),
          reasoning: z.boolean().optional(),
        })
        .partial()
        .optional(),
      expires_at: z.string().datetime().optional(),
    }),
  ),
});

export class OpenRouterModelCatalogAdapter implements ProviderModelCatalogPort {
  async fetchAll(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== "openrouter") {
      throw new ProviderModelDiscoveryApiError(
        `OpenRouter adapter does not support provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }

    const response = await requestOpenRouterModels(credentialContext.apiKey);
    const payload = await parseOpenRouterModels(response);
    return payload.data.map((entry) => toDiscoveredModel(entry));
  }

  async fetchUserModels(
    providerId: string,
    credentialContext: ProviderModelCredentialContext,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== "openrouter") {
      throw new ProviderModelDiscoveryApiError(
        `OpenRouter adapter does not support provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }

    const response = await requestOpenRouterUserModels(
      credentialContext.apiKey,
    );
    const payload = await parseOpenRouterModels(response);
    return payload.data.map((entry) => toDiscoveredModel(entry));
  }

  async fetchProgrammingModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    return this.fetchCategoryModels(providerId, "programming");
  }

  async fetchCategoryModels(
    providerId: string,
    category: OpenRouterDiscoveryCategory,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== "openrouter") {
      throw new ProviderModelDiscoveryApiError(
        `OpenRouter adapter does not support provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }

    const response = await requestOpenRouterCategoryModels(category);
    const payload = await parseOpenRouterModels(response);
    return payload.data.map((entry) => toDiscoveredModel(entry));
  }

  async fetchLeaderboardModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== "openrouter") {
      throw new ProviderModelDiscoveryApiError(
        `OpenRouter adapter does not support provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }

    const response = await makeOpenRouterRequest(
      OPENROUTER_RANKINGS_PAGE_ENDPOINT,
      null,
    );
    const html = await parseTextResponse(response);
    return extractModelsFromOpenRouterHtml(html);
  }

  async fetchFreeModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModel[]> {
    if (providerId !== "openrouter") {
      throw new ProviderModelDiscoveryApiError(
        `OpenRouter adapter does not support provider "${providerId}".`,
        { status: 400, retryable: false },
      );
    }

    const response = await makeOpenRouterRequest(
      OPENROUTER_FREE_ROUTER_PAGE_ENDPOINT,
      null,
    );
    const html = await parseTextResponse(response);
    return extractModelsFromOpenRouterHtml(html);
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
    const page = models.slice(offset, nextOffset);
    return {
      providerId: input.providerId,
      models: page,
      nextCursor: nextOffset < models.length ? String(nextOffset) : undefined,
      fetchedAt: new Date().toISOString(),
      source: "provider_api",
    };
  }
}

function toDiscoveredModel(
  entry: z.infer<typeof OpenRouterModelsEnvelopeSchema>["data"][number],
): BYOKDiscoveredProviderModel {
  const fetchedAt = new Date().toISOString();
  return {
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    providerId: "openrouter",
    contextWindow: entry.context_length,
    pricing: toPricing(entry.pricing),
    canonicalSlug: entry.slug,
    description: entry.description,
    supportedParameters: entry.supported_parameters,
    inputModalities: toInputModalities(entry.architecture),
    outputModalities: toOutputModalities(entry.architecture),
    capabilities: toCapabilities(
      entry.supported_parameters,
      entry.settings,
      entry.architecture,
    ),
    capabilityMetadata: toCapabilityMetadata(entry.architecture, fetchedAt),
    expirationDate: entry.expires_at,
  };
}

function toCapabilities(
  parameters: string[] | undefined,
  settings:
    | {
        structured_outputs?: boolean | undefined;
        reasoning?: boolean | undefined;
      }
    | undefined,
  architecture:
    | {
        input_modalities?: string[] | undefined;
        modality?: string | string[] | undefined;
        output_modalities?: string[] | undefined;
      }
    | undefined,
): BYOKModelCapability | undefined {
  if (!parameters?.length && !settings && !architecture) {
    return undefined;
  }
  const inputModalities = toInputModalities(architecture);
  return {
    supportsTools: supportsTools(parameters),
    supportsVision: inputModalities?.image,
    supportsStructuredOutputs: settings?.structured_outputs,
    supportsReasoning: settings?.reasoning,
  };
}

function toInputModalities(
  architecture:
    | {
        input_modalities?: string[] | undefined;
        modality?: string | string[] | undefined;
      }
    | undefined,
): BYOKModelInputModality | undefined {
  const normalized = normalizeModalities(
    architecture?.input_modalities ?? architecture?.modality,
  );
  if (normalized.length === 0) {
    return undefined;
  }
  return {
    text: normalized.includes("text"),
    image: normalized.includes("image"),
    audio: normalized.includes("audio"),
    video: normalized.includes("video"),
    file: normalized.includes("file"),
  };
}

function toOutputModalities(
  architecture:
    | {
        modality?: string | string[] | undefined;
        output_modalities?: string[] | undefined;
      }
    | undefined,
): BYOKModelOutputModality | undefined {
  const normalized = normalizeModalities(architecture?.output_modalities);
  if (normalized.length === 0) {
    return undefined;
  }
  return {
    text: normalized.includes("text"),
    image: normalized.includes("image"),
    audio: normalized.includes("audio"),
  };
}

function toCapabilityMetadata(
  architecture:
    | {
        input_modalities?: string[] | undefined;
        modality?: string | string[] | undefined;
        output_modalities?: string[] | undefined;
      }
    | undefined,
  fetchedAt: string,
): BYOKModelCapabilityMetadata | undefined {
  if (!architecture) {
    return undefined;
  }
  const hasExplicitModalities =
    architecture.input_modalities !== undefined ||
    architecture.output_modalities !== undefined;
  const hasLegacyModality = architecture.modality !== undefined;
  if (!hasExplicitModalities && !hasLegacyModality) {
    return undefined;
  }
  return {
    source: "provider_api",
    confidence: hasExplicitModalities ? "confirmed" : "declared",
    fetchedAt,
  };
}

function toPricing(
  pricing:
    | {
        prompt?: string | undefined;
        completion?: string | undefined;
      }
    | undefined,
) {
  if (!pricing) {
    return undefined;
  }
  const inputPer1M = parsePer1M(pricing.prompt);
  const outputPer1M = parsePer1M(pricing.completion);
  if (inputPer1M === undefined && outputPer1M === undefined) {
    return undefined;
  }
  return {
    inputPer1M,
    outputPer1M,
    currency: "USD",
  };
}

function parsePer1M(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const asNumber = Number(raw);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    return undefined;
  }
  return asNumber * 1_000_000;
}

function supportsTools(parameters: string[] | undefined): boolean | undefined {
  if (!parameters) {
    return undefined;
  }
  return parameters.includes("tools");
}

function normalizeModalities(
  modalities: string | string[] | undefined,
): string[] {
  if (!modalities) {
    return [];
  }
  if (Array.isArray(modalities)) {
    return modalities.map((value) => value.toLowerCase());
  }
  return modalities
    .toLowerCase()
    .replace(/->/g, "+")
    .split("+")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ProviderModelDiscoveryApiError(
      `Invalid OpenRouter pagination cursor "${cursor}".`,
      { status: 400, retryable: false },
    );
  }
  return parsed;
}

async function requestOpenRouterModels(apiKey: string): Promise<Response> {
  return makeOpenRouterRequest(OPENROUTER_MODELS_ENDPOINT, apiKey);
}

async function requestOpenRouterUserModels(apiKey: string): Promise<Response> {
  return makeOpenRouterRequest(OPENROUTER_USER_MODELS_ENDPOINT, apiKey);
}

async function requestOpenRouterCategoryModels(
  category: OpenRouterDiscoveryCategory,
): Promise<Response> {
  const endpoint = new URL(OPENROUTER_MODELS_ENDPOINT);
  endpoint.searchParams.set("category", category);
  return makeOpenRouterRequest(endpoint.toString(), null);
}

async function makeOpenRouterRequest(
  url: string,
  apiKey: string | null,
): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    OPENROUTER_FETCH_TIMEOUT_MS,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new ProviderModelDiscoveryApiError(
        `OpenRouter models request failed with status ${response.status}.`,
        { status: response.status, retryable: response.status >= 500 },
      );
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderModelDiscoveryApiError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new ProviderModelDiscoveryApiError(
        "OpenRouter models request timed out.",
        { status: 504, retryable: true },
      );
    }
    throw new ProviderModelDiscoveryApiError(
      `OpenRouter models request failed due to network error: ${toErrorMessage(error)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseOpenRouterModels(
  response: Response,
): Promise<z.infer<typeof OpenRouterModelsEnvelopeSchema>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderModelDiscoveryApiError(
      `OpenRouter models response body was not valid JSON: ${toErrorMessage(error)}`,
      { retryable: false },
    );
  }
  const parsed = OpenRouterModelsEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderModelNormalizationError(
      "OpenRouter models response failed schema validation.",
    );
  }
  return parsed.data;
}

async function parseTextResponse(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new ProviderModelDiscoveryApiError(
      `OpenRouter page response could not be read as text: ${toErrorMessage(error)}`,
      { retryable: false },
    );
  }
}

function extractModelsFromOpenRouterHtml(
  html: string,
): BYOKDiscoveredProviderModel[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(OPENROUTER_MODEL_LINK_PATTERN)) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    const [prefix] = candidate.split("/");
    if (!prefix || OPENROUTER_NON_MODEL_LINK_PREFIXES.has(prefix)) {
      continue;
    }
    ids.add(candidate);
  }

  return Array.from(ids).map((id) => ({
    id,
    name: id,
    providerId: "openrouter",
  }));
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
