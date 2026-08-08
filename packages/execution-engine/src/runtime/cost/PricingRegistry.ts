// apps/brain/src/core/cost/PricingRegistry.ts
// Phase 3.1: Registry pricing with boot-time seed loading

import type {
  LLMUsage,
  CalculatedCost,
  PricingEntry,
  PricingTierEntry,
} from "./types.js";
import { DEFAULT_SEED_PRICING } from "./pricing.default.js";
import { BYOKModelPricingSchema } from "@repo/shared-types";

export interface PricingRegistryOptions {
  failOnUnseededPricing?: boolean;
  isProduction?: boolean;
  staleThresholdDays?: number;
  failOnStale?: boolean;
}

export interface IPricingRegistry {
  getPrice(provider: string, model: string): PricingEntry | null;
  calculateCost(usage: LLMUsage): CalculatedCost;
  registerPrice(provider: string, model: string, entry: PricingEntry): void;
  loadFromJSON(pricingData: Record<string, PricingEntry>): void;
  getAllPrices(): Record<string, PricingEntry>;
}

export class PricingRegistry implements IPricingRegistry {
  private prices = new Map<string, PricingEntry>();
  private readonly options: Required<PricingRegistryOptions>;
  private static lastSeedLoadLogAt = 0;
  private static readonly SEED_LOAD_LOG_WINDOW_MS = 5 * 60 * 1000;

  constructor(
    initialPricing?: Record<string, PricingEntry>,
    options?: PricingRegistryOptions,
  ) {
    this.options = {
      failOnUnseededPricing: options?.failOnUnseededPricing ?? false,
      isProduction: options?.isProduction ?? detectProductionEnvironment(),
      staleThresholdDays: options?.staleThresholdDays ?? 90,
      failOnStale: options?.failOnStale ?? false,
    };

    if (initialPricing) {
      this.loadFromJSON(initialPricing);
      return;
    }

    this.loadDefaultSeedPricing();
  }

  getPrice(provider: string, model: string): PricingEntry | null {
    return this.prices.get(`${provider}:${model}`) ?? null;
  }

  calculateCost(usage: LLMUsage): CalculatedCost {
    if (usage.cost !== undefined && usage.cost > 0) {
      return {
        inputCost: 0,
        outputCost: 0,
        totalCost: usage.cost,
        currency: "USD",
        pricingSource: "provider",
      };
    }

    const pricing = this.getPrice(usage.provider, usage.model);
    if (!pricing) {
      return {
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        currency: "USD",
        pricingSource: "unknown",
      };
    }

    const activePricing = resolvePricingTier(pricing, usage.promptTokens);
    const cachedInputTokens = Math.min(
      usage.cachedInputTokens ?? 0,
      usage.promptTokens,
    );
    const uncachedInputTokens = Math.max(
      0,
      usage.promptTokens - cachedInputTokens,
    );
    const cacheReadPrice =
      activePricing.cacheReadPrice ??
      pricing.cacheReadPrice ??
      activePricing.inputPrice;
    const inputCost =
      (uncachedInputTokens / 1000) * activePricing.inputPrice;
    const cacheReadCost = (cachedInputTokens / 1000) * cacheReadPrice;
    const outputCost =
      (usage.completionTokens / 1000) * activePricing.outputPrice;

    return {
      inputCost,
      outputCost,
      totalCost: inputCost + cacheReadCost + outputCost,
      currency: pricing.currency,
      pricingSource: "registry",
    };
  }

  registerPrice(provider: string, model: string, entry: PricingEntry): void {
    const key = `${provider}:${model}`;
    const normalized = this.normalizePricingEntry(key, entry);
    this.validateStaleness(key, normalized);
    this.prices.set(key, normalized);
    console.log(`[cost/pricing] Registered pricing: ${key}`);
  }

  loadFromJSON(pricingData: Record<string, PricingEntry>): void {
    this.loadPricingEntries(pricingData, false);
  }

  getAllPrices(): Record<string, PricingEntry> {
    const prices: Record<string, PricingEntry> = {};
    for (const [key, value] of this.prices.entries()) {
      prices[key] = value;
    }
    return prices;
  }

  clear(): void {
    this.prices.clear();
  }

  private loadDefaultSeedPricing(): void {
    const failClosed =
      this.options.failOnUnseededPricing || this.options.isProduction;

    try {
      const parsedSeed = this.parsePricingData(DEFAULT_SEED_PRICING);
      const loadedCount = this.loadPricingEntries(parsedSeed, !failClosed);
      this.logSeedLoadOnce(loadedCount);
      if (loadedCount === 0 && failClosed) {
        throw new PricingError("No valid entries found in default seed pricing");
      }
    } catch (error) {
      if (failClosed) {
        throw new PricingError("Failed to load default seed pricing", error);
      }
      console.warn(
        "[cost/pricing] Failed to load seeded pricing. Continuing in non-production mode.",
      );
    }
  }

  private normalizePricingEntry(key: string, entry: PricingEntry): PricingEntry {
    const rawEntry = this.parsePricingDataEntry(key, entry);
    const inputPrice = this.parseFiniteNumber(
      rawEntry.inputPrice,
      key,
      "inputPrice",
    );
    const outputPrice = this.parseFiniteNumber(
      rawEntry.outputPrice,
      key,
      "outputPrice",
    );
    const currency = this.parseCurrency(rawEntry.currency, key);
    const cacheReadPrice = this.parseOptionalFiniteNumber(
      rawEntry.cacheReadPrice,
      key,
      "cacheReadPrice",
    );
    const cacheWritePrice = this.parseOptionalFiniteNumber(
      rawEntry.cacheWritePrice,
      key,
      "cacheWritePrice",
    );
    const tiers = this.parsePricingTiers(rawEntry.tiers, key);
    const effectiveDateCandidate = this.parseOptionalString(rawEntry.effectiveDate);
    const lastUpdatedCandidate = this.parseOptionalString(rawEntry.lastUpdated);
    const effectiveDate = effectiveDateCandidate ?? lastUpdatedCandidate;

    if (!effectiveDate) {
      throw new PricingError(
        `Pricing entry ${key} must include effectiveDate or lastUpdated`,
      );
    }

    return {
      inputPrice,
      outputPrice,
      ...(cacheReadPrice !== undefined ? { cacheReadPrice } : {}),
      ...(cacheWritePrice !== undefined ? { cacheWritePrice } : {}),
      ...(tiers ? { tiers } : {}),
      currency,
      effectiveDate,
      lastUpdated: lastUpdatedCandidate ?? effectiveDate,
      metadata: this.parseMetadata(rawEntry.metadata, key),
    };
  }

  private validateStaleness(key: string, entry: PricingEntry): void {
    const dateString = entry.effectiveDate ?? entry.lastUpdated;
    if (!dateString) {
      return;
    }

    const parsed = new Date(dateString);
    if (Number.isNaN(parsed.getTime())) {
      throw new PricingError(
        `Pricing entry ${key} has invalid date: ${dateString}`,
      );
    }

    const ageMs = Date.now() - parsed.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    if (ageDays <= this.options.staleThresholdDays) {
      return;
    }

    const source = entry.metadata?.source ?? "unknown";
    const version = entry.metadata?.version ?? "unknown";
    const message =
      `Stale pricing detected for ${key}: ${ageDays} days old ` +
      `(threshold=${this.options.staleThresholdDays}, source=${source}, version=${version})`;

    if (this.options.failOnStale) {
      throw new PricingError(message);
    }
    if (!detectTestEnvironment()) {
      console.warn(`[cost/pricing] ${message}`);
    }
  }

  private loadPricingEntries(
    pricingData: Record<string, PricingEntry>,
    skipInvalidEntries: boolean,
  ): number {
    let loadedCount = 0;
    for (const [key, entry] of Object.entries(pricingData)) {
      try {
        const normalized = this.normalizePricingEntry(key, entry);
        this.validateStaleness(key, normalized);
        this.prices.set(key, normalized);
        loadedCount += 1;
      } catch (error) {
        if (!skipInvalidEntries) {
          throw error;
        }
        console.warn(
          `[cost/pricing] Skipping invalid pricing entry ${key}: ${getErrorMessage(error)}`,
        );
      }
    }
    return loadedCount;
  }

  private logSeedLoadOnce(loadedCount: number): void {
    const now = Date.now();
    if (
      now - PricingRegistry.lastSeedLoadLogAt <
      PricingRegistry.SEED_LOAD_LOG_WINDOW_MS
    ) {
      return;
    }
    PricingRegistry.lastSeedLoadLogAt = now;
    console.log(`[cost/pricing] Loaded ${loadedCount} seeded prices`);
  }

  private parsePricingData(pricingData: unknown): Record<string, PricingEntry> {
    if (
      !pricingData ||
      typeof pricingData !== "object" ||
      Array.isArray(pricingData)
    ) {
      throw new PricingError("Pricing JSON must be an object map");
    }
    return pricingData as Record<string, PricingEntry>;
  }

  private parsePricingDataEntry(
    key: string,
    entry: PricingEntry,
  ): Record<string, unknown> {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PricingError(`Pricing entry ${key} must be an object`);
    }
    return entry as unknown as Record<string, unknown>;
  }

  private parseFiniteNumber(
    value: unknown,
    key: string,
    fieldName: string,
  ): number {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new PricingError(`Pricing entry ${key} has invalid ${fieldName}`);
    }
    return parsed;
  }

  private parseOptionalFiniteNumber(
    value: unknown,
    key: string,
    fieldName: string,
  ): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.parseFiniteNumber(value, key, fieldName);
  }

  private parsePricingTiers(
    value: unknown,
    key: string,
  ): PricingTierEntry[] | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new PricingError(`Pricing entry ${key} has invalid tiers`);
    }
    return value
      .map((tier, index) => {
        if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
          throw new PricingError(
            `Pricing entry ${key} has invalid tier at index ${index}`,
          );
        }
        const rawTier = tier as Record<string, unknown>;
        const minimumContextTokens = this.parseFiniteNumber(
          rawTier.minimumContextTokens,
          key,
          "minimumContextTokens",
        );
        if (
          !Number.isSafeInteger(minimumContextTokens) ||
          minimumContextTokens < 0
        ) {
          throw new PricingError(
            `Pricing entry ${key} has invalid minimumContextTokens`,
          );
        }
        const cacheReadPrice = this.parseOptionalFiniteNumber(
          rawTier.cacheReadPrice,
          key,
          "tier.cacheReadPrice",
        );
        const cacheWritePrice = this.parseOptionalFiniteNumber(
          rawTier.cacheWritePrice,
          key,
          "tier.cacheWritePrice",
        );
        return {
          minimumContextTokens,
          inputPrice: this.parseFiniteNumber(
            rawTier.inputPrice,
            key,
            "tier.inputPrice",
          ),
          outputPrice: this.parseFiniteNumber(
            rawTier.outputPrice,
            key,
            "tier.outputPrice",
          ),
          ...(cacheReadPrice !== undefined ? { cacheReadPrice } : {}),
          ...(cacheWritePrice !== undefined ? { cacheWritePrice } : {}),
        };
      })
      .sort(
        (first, second) =>
          first.minimumContextTokens - second.minimumContextTokens,
      );
  }

  private parseCurrency(value: unknown, key: string): string {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    throw new PricingError(`Pricing entry ${key} has invalid currency`);
  }

  private parseOptionalString(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new PricingError("Pricing date fields must be strings");
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private parseMetadata(
    value: unknown,
    key: string,
  ): { source?: string; version?: string } {
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new PricingError(`Pricing entry ${key} has invalid metadata`);
    }
    const metadata = value as Record<string, unknown>;
    const source = this.parseMetadataField(metadata.source, "source", key);
    const version = this.parseMetadataField(metadata.version, "version", key);
    return {
      ...(source ? { source } : {}),
      ...(version ? { version } : {}),
    };
  }

  private parseMetadataField(
    value: unknown,
    field: "source" | "version",
    key: string,
  ): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new PricingError(`Pricing entry ${key} has invalid metadata.${field}`);
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
}

function resolvePricingTier(
  pricing: PricingEntry,
  contextTokens: number,
): PricingEntry | PricingTierEntry {
  const tiers = pricing.tiers;
  if (!tiers?.length) {
    return pricing;
  }
  return (
    [...tiers]
      .filter((tier) => tier.minimumContextTokens <= contextTokens)
      .sort(
        (first, second) =>
          second.minimumContextTokens - first.minimumContextTokens,
      )[0] ?? pricing
  );
}

/**
 * Registers a selected model's catalog price. models.dev and provider model
 * APIs publish USD per million tokens, while PricingRegistry calculates per
 * thousand tokens, so conversion belongs at this boundary.
 */
export function registerRuntimeModelPricing(
  registry: IPricingRegistry,
  input: {
    providerId?: string;
    modelId?: string;
    runtimeModelId?: string;
    pricing?: unknown;
  },
): boolean {
  const providerId = input.providerId?.trim();
  const modelIds = [input.modelId, input.runtimeModelId]
    .map((modelId) => modelId?.trim())
    .filter((modelId): modelId is string => Boolean(modelId));
  const parsedPricing = BYOKModelPricingSchema.safeParse(input.pricing);
  if (
    !providerId ||
    modelIds.length === 0 ||
    !parsedPricing.success ||
    parsedPricing.data.inputPer1M === undefined ||
    parsedPricing.data.outputPer1M === undefined
  ) {
    return false;
  }

  const now = new Date().toISOString();
  const tiers = parsedPricing.data.tiers?.map((tier) => ({
    minimumContextTokens: tier.minimumContextTokens,
    inputPrice: tier.inputPer1M / 1_000,
    outputPrice: tier.outputPer1M / 1_000,
    ...(tier.cacheReadPer1M !== undefined
      ? { cacheReadPrice: tier.cacheReadPer1M / 1_000 }
      : {}),
    ...(tier.cacheWritePer1M !== undefined
      ? { cacheWritePrice: tier.cacheWritePer1M / 1_000 }
      : {}),
  }));
  const entry: PricingEntry = {
    inputPrice: parsedPricing.data.inputPer1M / 1_000,
    outputPrice: parsedPricing.data.outputPer1M / 1_000,
    currency: parsedPricing.data.currency,
    ...(parsedPricing.data.cacheReadPer1M !== undefined
      ? { cacheReadPrice: parsedPricing.data.cacheReadPer1M / 1_000 }
      : {}),
    ...(parsedPricing.data.cacheWritePer1M !== undefined
      ? { cacheWritePrice: parsedPricing.data.cacheWritePer1M / 1_000 }
      : {}),
    ...(tiers?.length ? { tiers } : {}),
    effectiveDate: now,
    lastUpdated: now,
    metadata: { source: "provider-model-catalog" },
  };
  for (const modelId of new Set(modelIds)) {
    registry.registerPrice(providerId, modelId, entry);
  }
  return true;
}

function detectProductionEnvironment(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return process.env?.NODE_ENV === "production";
}

function detectTestEnvironment(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return process.env?.NODE_ENV === "test";
}

export class PricingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`[cost/pricing] ${message}`);
    if (cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack ?? cause.message}`;
    }
    this.name = "PricingError";
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown pricing error";
}
