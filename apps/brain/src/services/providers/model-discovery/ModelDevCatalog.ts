/**
 * models.dev catalog enrichment
 *
 * Mirrors OpenCode's catalog behavior: when a provider model-list endpoint
 * omits capabilities, context limits, or modalities, the canonical models.dev
 * catalog (https://models.dev/api.json) supplies provider-owned metadata.
 *
 * Enrichment is additive only: fields already declared by the provider API
 * are never overwritten. Catalog fetch failures degrade to the un-enriched
 * provider response, which is exactly the behavior before this feature.
 */

import { z } from "zod";
import {
  ReasoningEffortSchema,
  type BYOKDiscoveredProviderModel,
  type BYOKModelPricing,
  type ReasoningEffort,
} from "@repo/shared-types";

const MODEL_DEV_CATALOG_URL = "https://models.dev/api.json";
const MODEL_DEV_CATALOG_TTL_MS = 60 * 60 * 1000;
const MODEL_DEV_CATALOG_FAILURE_TTL_MS = 60 * 1000;
const MODEL_DEV_REQUEST_TIMEOUT_MS = 10_000;
const MODEL_DEV_REQUEST_ATTEMPTS = 3;

let sharedCatalogCache:
  | { catalog: ModelDevCatalog | null; expiresAt: number }
  | null = null;
let sharedCatalogFetchPromise: Promise<ModelDevCatalog | null> | null = null;

const ModelDevModelSchema = z.object({
  provider: z
    .object({
      npm: z.string().min(1).optional(),
      api: z.string().url().optional(),
    })
    .optional(),
  limit: z
    .object({
      context: z.number().int().nonnegative().optional(),
      input: z.number().int().nonnegative().optional(),
      output: z.number().int().nonnegative().optional(),
    })
    .optional(),
  modalities: z
    .object({
      input: z.array(z.string()).optional(),
      output: z.array(z.string()).optional(),
    })
    .optional(),
  cost: z
    .object({
      input: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
      cache_read: z.number().nonnegative().optional(),
      cache_write: z.number().nonnegative().optional(),
      tiers: z
        .array(
          z.object({
            input: z.number().nonnegative(),
            output: z.number().nonnegative(),
            cache_read: z.number().nonnegative().optional(),
            cache_write: z.number().nonnegative().optional(),
            tier: z.object({
              type: z.string(),
              size: z.number().nonnegative(),
            }),
          }),
        )
        .optional(),
      context_over_200k: z
        .object({
          input: z.number().nonnegative(),
          output: z.number().nonnegative(),
          cache_read: z.number().nonnegative().optional(),
          cache_write: z.number().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(
      z.object({
        type: z.string(),
        values: z.array(z.string().nullable()).optional(),
      }),
    )
    .optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
});

export interface ModelDevCatalog {
  providers: Record<
    string,
    {
      api?: string;
      npm?: string;
      models: Record<string, ModelDevModel>;
    }
  >;
  fetchedAt: string;
}

export interface ModelDevModel {
  provider?: { npm?: string; api?: string };
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  cost?: ModelDevCost;
  reasoning?: boolean;
  reasoning_options?: Array<{
    type: string;
    values?: Array<string | null>;
  }>;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
}

interface ModelDevCostTier {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  tier: { type: string; size: number };
}

interface ModelDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: ModelDevCostTier[];
  context_over_200k?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
}

/**
 * Loads and validates the models.dev catalog snapshot. Returns null when the
 * fetch or payload is unusable so callers can degrade gracefully.
 */
export function parseModelDevCatalog(
  raw: unknown,
  fetchedAt = new Date().toISOString(),
): ModelDevCatalog | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const providers: ModelDevCatalog["providers"] = {};
  for (const [providerId, providerValue] of Object.entries(raw)) {
    if (
      !providerValue ||
      typeof providerValue !== "object" ||
      Array.isArray(providerValue)
    ) {
      continue;
    }
    const modelsValue = (providerValue as Record<string, unknown>).models;
    if (!modelsValue || typeof modelsValue !== "object" || Array.isArray(modelsValue)) {
      continue;
    }
    const models: Record<string, ModelDevModel> = {};
    for (const [modelId, modelValue] of Object.entries(modelsValue)) {
      const parsed = ModelDevModelSchema.safeParse(modelValue);
      if (parsed.success) {
        models[modelId] = parsed.data;
      }
    }
    const providerRecord = providerValue as Record<string, unknown>;
    const api = z.string().url().safeParse(providerRecord.api);
    const npm = z.string().min(1).safeParse(providerRecord.npm);
    providers[providerId] = {
      ...(api.success ? { api: api.data } : {}),
      ...(npm.success ? { npm: npm.data } : {}),
      models,
    };
  }
  return Object.keys(providers).length > 0 ? { providers, fetchedAt } : null;
}

export interface ModelDevCatalogSource {
  getCatalog(): Promise<ModelDevCatalog | null>;
}

/**
 * Production source: fetches the canonical models.dev catalog over HTTP.
 * Fetch failures return null (best-effort enrichment).
 */
export class HttpModelDevCatalogSource implements ModelDevCatalogSource {
  constructor(
    private readonly fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
    private readonly url: string = MODEL_DEV_CATALOG_URL,
  ) {}

  async getCatalog(): Promise<ModelDevCatalog | null> {
    if (
      this.fetchJson === defaultFetchJson &&
      this.url === MODEL_DEV_CATALOG_URL
    ) {
      return getSharedCatalog(this.url);
    }
    return this.fetchCatalog();
  }

  private async fetchCatalog(): Promise<ModelDevCatalog | null> {
    return fetchAndParseCatalog(this.fetchJson, this.url);
  }
}

async function fetchAndParseCatalog(
  fetchJson: (url: string) => Promise<unknown>,
  url: string,
): Promise<ModelDevCatalog | null> {
  try {
    const raw = await fetchJson(url);
    return parseModelDevCatalog(raw);
  } catch (_error) {
    return null;
  }
}

async function getSharedCatalog(url: string): Promise<ModelDevCatalog | null> {
  if (sharedCatalogCache && sharedCatalogCache.expiresAt > Date.now()) {
    return sharedCatalogCache.catalog;
  }
  if (!sharedCatalogFetchPromise) {
    sharedCatalogFetchPromise = fetchAndParseCatalog(defaultFetchJson, url)
      .then((catalog) => {
        const lastGoodCatalog = catalog ?? sharedCatalogCache?.catalog ?? null;
        sharedCatalogCache = {
          catalog: lastGoodCatalog,
          expiresAt:
            Date.now() +
            (catalog
              ? MODEL_DEV_CATALOG_TTL_MS
              : MODEL_DEV_CATALOG_FAILURE_TTL_MS),
        };
        return lastGoodCatalog;
      })
      .finally(() => {
        sharedCatalogFetchPromise = null;
      });
  }
  return sharedCatalogFetchPromise;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MODEL_DEV_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      MODEL_DEV_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const error = new Error(
          `models.dev catalog request failed with ${response.status}`,
        );
        if (!isRetryableCatalogStatus(response.status)) {
          lastError = error;
          break;
        }
        lastError = error;
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === MODEL_DEV_REQUEST_ATTEMPTS) {
        break;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("models.dev catalog request failed");
}

function isRetryableCatalogStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Fills provider-omitted metadata from the models.dev catalog. Every field
 * already declared by the provider API wins over the catalog.
 */
export function enrichModelFromModelDev(
  catalog: ModelDevCatalog,
  providerId: string,
  model: BYOKDiscoveredProviderModel,
): BYOKDiscoveredProviderModel {
  const entry = findModelDevEntry(catalog, providerId, model.id);
  if (!entry) {
    return model;
  }

  const next: BYOKDiscoveredProviderModel = { ...model };
  let metadataChanged = false;
  if (
    next.contextWindow === undefined &&
    entry.limit?.context !== undefined &&
    entry.limit.context > 0
  ) {
    next.contextWindow = entry.limit.context;
    metadataChanged = true;
  }
  if (next.inputModalities === undefined && entry.modalities?.input?.length) {
    next.inputModalities = toInputModalities(entry.modalities.input);
    metadataChanged = true;
  }
  if (next.outputModalities === undefined && entry.modalities?.output?.length) {
    next.outputModalities = toOutputModalities(entry.modalities.output);
    metadataChanged = true;
  }
  if (providerId !== "axis" && entry.cost) {
    const pricing = mergePricing(next.pricing, toPricing(entry.cost));
    if (pricing) {
      next.pricing = pricing;
      metadataChanged = true;
    }
  }

  const capabilities = { ...next.capabilities };
  let capabilityChanged = false;
  if (capabilities.supportsReasoning === undefined && entry.reasoning !== undefined) {
    capabilities.supportsReasoning = entry.reasoning;
    capabilityChanged = true;
  }
  if (
    capabilities.reasoningEfforts === undefined &&
    entry.reasoning_options?.length
  ) {
    const efforts = toReasoningEfforts(entry.reasoning_options);
    if (efforts.length > 0) {
      capabilities.reasoningEfforts = efforts;
      capabilityChanged = true;
    }
  }
  if (capabilities.supportsTools === undefined && entry.tool_call !== undefined) {
    capabilities.supportsTools = entry.tool_call;
    capabilityChanged = true;
  }
  if (
    capabilities.supportsStructuredOutputs === undefined &&
    entry.structured_output !== undefined
  ) {
    capabilities.supportsStructuredOutputs = entry.structured_output;
    capabilityChanged = true;
  }
  if (
    capabilities.supportsVision === undefined &&
    entry.modalities?.input !== undefined
  ) {
    capabilities.supportsVision = entry.modalities.input.includes("image");
    capabilityChanged = true;
  }

  if (capabilityChanged) {
    next.capabilities = capabilities;
    metadataChanged = true;
  }

  const runtimeRoute = resolveModelDevRuntimeRoute(
    catalog,
    providerId,
    model.id,
    entry,
  );
  if (runtimeRoute) {
    next.runtimeRoute = runtimeRoute;
    next.availability = "available";
    delete next.unavailableReason;
    metadataChanged = true;
  }
  if (metadataChanged && next.capabilityMetadata === undefined) {
    next.capabilityMetadata = {
      source: "platform_registry",
      confidence: "declared",
      fetchedAt: catalog.fetchedAt,
    };
  }

  return next;
}

function findModelDevEntry(
  catalog: ModelDevCatalog,
  providerId: string,
  modelId: string,
): ModelDevModel | undefined {
  const normalized = modelId.trim().toLowerCase();
  const candidates = [
    normalized,
    stripKnownProviderPrefix(normalized),
  ].filter((candidate): candidate is string => candidate !== undefined);

  const providerIds = resolveCatalogProviderIds(catalog, providerId);
  for (const catalogProviderId of providerIds) {
    const provider = catalog.providers[catalogProviderId];
    if (!provider) {
      continue;
    }
    for (const candidate of candidates) {
      const entry = findModelById(provider.models, candidate);
      if (entry) {
        return entry;
      }
    }
  }
  return undefined;
}

function resolveModelDevRuntimeRoute(
  catalog: ModelDevCatalog,
  providerId: string,
  modelId: string,
  model: ModelDevModel,
): BYOKDiscoveredProviderModel["runtimeRoute"] | undefined {
  if (providerId !== "opencode-zen" && providerId !== "opencode-go") {
    return undefined;
  }
  const catalogProviderId =
    providerId === "opencode-zen" ? "opencode" : "opencode-go";
  const provider = catalog.providers[catalogProviderId];
  const api = model.provider?.api ?? provider?.api;
  const npm = model.provider?.npm ?? provider?.npm;
  if (!api || !npm) {
    return undefined;
  }
  const baseUrl = api.replace(/\/$/, "");
  if (npm === "@ai-sdk/openai") {
    return {
      providerId,
      modelId,
      transport: "openai-responses",
      endpoint: `${baseUrl}/responses`,
    };
  }
  if (npm === "@ai-sdk/anthropic") {
    return {
      providerId,
      modelId,
      transport: "anthropic-messages",
      endpoint: `${baseUrl}/messages`,
    };
  }
  if (npm === "@ai-sdk/google") {
    return {
      providerId,
      modelId,
      transport: "google-generative",
      endpoint: baseUrl,
    };
  }
  if (npm === "@ai-sdk/openai-compatible") {
    return {
      providerId,
      modelId,
      transport: "openai-chat-completions",
      endpoint: `${baseUrl}/chat/completions`,
    };
  }
  return undefined;
}

function resolveCatalogProviderIds(
  catalog: ModelDevCatalog,
  providerId: string,
): string[] {
  const aliases: Record<string, readonly string[]> = {
    axis: ["openrouter"],
    together: ["togetherai"],
    "opencode-zen": ["opencode"],
    "cloudflare-ai": ["cloudflare-workers-ai", "cloudflare-ai-gateway"],
  };
  const candidates = [providerId, ...(aliases[providerId] ?? [])];
  return candidates.filter((candidate, index) => {
    if (!catalog.providers[candidate]) {
      return false;
    }
    return candidates.indexOf(candidate) === index;
  });
}

function findModelById(
  models: Record<string, ModelDevModel>,
  candidate: string,
): ModelDevModel | undefined {
  const direct = models[candidate];
  if (direct) {
    return direct;
  }
  const matchingKey = Object.keys(models).find(
    (modelId) => modelId.toLowerCase() === candidate,
  );
  return matchingKey ? models[matchingKey] : undefined;
}

function stripKnownProviderPrefix(
  normalized: string,
): string | undefined {
  const withoutPrefix = normalized.replace(/^(openai|google|gemini|anthropic)\//, "");
  return withoutPrefix === normalized ? undefined : withoutPrefix;
}

function toInputModalities(input: string[]): Record<string, boolean> {
  const modalities: Record<string, boolean> = {};
  for (const modality of input) {
    const key = toInputModalityKey(modality);
    if (key) {
      modalities[key] = true;
    }
  }
  return modalities;
}

function toInputModalityKey(modality: string): string | undefined {
  if (modality === "pdf") {
    return "file";
  }
  if (
    modality === "text" ||
    modality === "image" ||
    modality === "audio" ||
    modality === "video"
  ) {
    return modality;
  }
  return undefined;
}

function toOutputModalities(output: string[]): Record<string, boolean> {
  const modalities: Record<string, boolean> = {};
  for (const modality of output) {
    if (
      modality === "text" ||
      modality === "image" ||
      modality === "audio"
    ) {
      modalities[modality] = true;
    }
  }
  return modalities;
}

function toPricing(cost: ModelDevCost): BYOKModelPricing | undefined {
  const tiers = [
    ...(cost.tiers ?? [])
      .filter((tier) => tier.tier.type === "context")
      .map((tier) => toPricingTier(tier.tier.size, tier)),
    ...(cost.context_over_200k
      ? [toPricingTier(200_000, cost.context_over_200k)]
      : []),
  ].sort(
    (first, second) =>
      first.minimumContextTokens - second.minimumContextTokens,
  );
  if (
    cost.input === undefined &&
    cost.output === undefined &&
    tiers.length === 0
  ) {
    return undefined;
  }
  return {
    ...(cost.input !== undefined ? { inputPer1M: cost.input } : {}),
    ...(cost.output !== undefined ? { outputPer1M: cost.output } : {}),
    ...(cost.cache_read !== undefined
      ? { cacheReadPer1M: cost.cache_read }
      : {}),
    ...(cost.cache_write !== undefined
      ? { cacheWritePer1M: cost.cache_write }
      : {}),
    ...(tiers.length ? { tiers } : {}),
    currency: "USD",
  };
}

function mergePricing(
  providerPricing: BYOKModelPricing | undefined,
  catalogPricing: BYOKModelPricing | undefined,
): BYOKModelPricing | undefined {
  if (!providerPricing) {
    return catalogPricing;
  }
  if (!catalogPricing) {
    return providerPricing;
  }
  const inputPer1M = providerPricing.inputPer1M ?? catalogPricing.inputPer1M;
  const outputPer1M =
    providerPricing.outputPer1M ?? catalogPricing.outputPer1M;
  const cacheReadPer1M =
    providerPricing.cacheReadPer1M ?? catalogPricing.cacheReadPer1M;
  const cacheWritePer1M =
    providerPricing.cacheWritePer1M ?? catalogPricing.cacheWritePer1M;
  const tiers = providerPricing.tiers ?? catalogPricing.tiers;
  return {
    ...(inputPer1M !== undefined ? { inputPer1M } : {}),
    ...(outputPer1M !== undefined ? { outputPer1M } : {}),
    ...(cacheReadPer1M !== undefined ? { cacheReadPer1M } : {}),
    ...(cacheWritePer1M !== undefined ? { cacheWritePer1M } : {}),
    ...(tiers ? { tiers } : {}),
    currency: providerPricing.currency || catalogPricing.currency,
  };
}

function toPricingTier(
  minimumContextTokens: number,
  cost: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  },
) {
  return {
    minimumContextTokens,
    inputPer1M: cost.input,
    outputPer1M: cost.output,
    ...(cost.cache_read !== undefined
      ? { cacheReadPer1M: cost.cache_read }
      : {}),
    ...(cost.cache_write !== undefined
      ? { cacheWritePer1M: cost.cache_write }
      : {}),
  };
}

function toReasoningEfforts(
  options: Array<{ type: string; values?: Array<string | null> }>,
): ReasoningEffort[] {
  const efforts: ReasoningEffort[] = [];
  for (const option of options) {
    if (option.type === "effort" && option.values?.length) {
      for (const value of option.values) {
        const parsed = ReasoningEffortSchema.safeParse(value);
        if (parsed.success) {
          efforts.push(parsed.data);
        }
      }
    }
  }
  return Array.from(new Set(efforts));
}
