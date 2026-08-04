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
import type {
  BYOKDiscoveredProviderModel,
  ReasoningEffort,
} from "@repo/shared-types";

const MODEL_DEV_CATALOG_URL = "https://models.dev/api.json";

const ModelDevModelSchema = z.object({
  limit: z
    .object({
      context: z.number().int().positive().optional(),
      input: z.number().int().positive().optional(),
      output: z.number().int().positive().optional(),
    })
    .optional(),
  modalities: z
    .object({
      input: z.array(z.string()).optional(),
      output: z.array(z.string()).optional(),
    })
    .optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(
      z.object({
        type: z.string(),
        values: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
});

const ModelDevCatalogSchema = z.record(
  z.object({
    models: z.record(ModelDevModelSchema),
  }),
);

export interface ModelDevCatalog {
  providers: Record<string, { models: Record<string, ModelDevModel> }>;
  fetchedAt: string;
}

export interface ModelDevModel {
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
}

/**
 * Loads and validates the models.dev catalog snapshot. Returns null when the
 * fetch or payload is unusable so callers can degrade gracefully.
 */
export function parseModelDevCatalog(
  raw: unknown,
  fetchedAt = new Date().toISOString(),
): ModelDevCatalog | null {
  const parsed = ModelDevCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return { providers: parsed.data, fetchedAt };
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
    try {
      const raw = await this.fetchJson(this.url);
      return parseModelDevCatalog(raw);
    } catch (_error) {
      return null;
    }
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`models.dev catalog request failed with ${response.status}`);
  }
  return response.json();
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
  if (next.contextWindow === undefined && entry.limit?.context) {
    next.contextWindow = entry.limit.context;
  }
  if (next.inputModalities === undefined && entry.modalities?.input?.length) {
    next.inputModalities = toInputModalities(entry.modalities.input);
  }
  if (next.outputModalities === undefined && entry.modalities?.output?.length) {
    next.outputModalities = toOutputModalities(entry.modalities.output);
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
    entry.modalities?.input?.includes("image")
  ) {
    capabilities.supportsVision = true;
    capabilityChanged = true;
  }

  if (capabilityChanged) {
    next.capabilities = capabilities;
    if (next.capabilityMetadata === undefined) {
      next.capabilityMetadata = {
        source: "platform_registry",
        confidence: "declared",
        fetchedAt: catalog.fetchedAt,
      };
    }
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

  const provider = catalog.providers[providerId];
  if (provider) {
    for (const candidate of candidates) {
      const entry = provider.models[candidate];
      if (entry) {
        return entry;
      }
    }
    return undefined;
  }

  for (const providerId of priorityProviderIds(catalog)) {
    const provider = catalog.providers[providerId];
    if (!provider) {
      continue;
    }
    for (const candidate of candidates) {
      const entry = provider.models[candidate];
      if (entry) {
        return entry;
      }
    }
  }
  return undefined;
}

function priorityProviderIds(catalog: ModelDevCatalog): string[] {
  const priority = ["openai", "google", "anthropic", "openrouter"];
  const seen = new Set(priority);
  return [
    ...priority,
    ...Object.keys(catalog.providers).filter((providerId) => !seen.has(providerId)),
  ];
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

function toReasoningEfforts(
  options: Array<{ type: string; values?: string[] }>,
): ReasoningEffort[] {
  const efforts: ReasoningEffort[] = [];
  for (const option of options) {
    if (option.type === "effort" && option.values?.length) {
      efforts.push(...option.values);
    }
  }
  return Array.from(new Set(efforts));
}
