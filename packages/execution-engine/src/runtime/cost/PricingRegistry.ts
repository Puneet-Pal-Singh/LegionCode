// apps/brain/src/core/cost/PricingRegistry.ts
// Phase 3.1: Registry pricing with boot-time seed loading

import type { LLMUsage, CalculatedCost, PricingEntry } from "./types.js";
import { DEFAULT_SEED_PRICING } from "./pricing.default.js";

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

    const inputCost = (usage.promptTokens / 1000) * pricing.inputPrice;
    const outputCost = (usage.completionTokens / 1000) * pricing.outputPrice;

    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
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
    const inputPrice = this.parseFiniteNumber(rawEntry.inputPrice, key, "inputPrice");
    const outputPrice = this.parseFiniteNumber(
      rawEntry.outputPrice,
      key,
      "outputPrice",
    );
    const currency = this.parseCurrency(rawEntry.currency, key);
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
    fieldName: "inputPrice" | "outputPrice",
  ): number {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      throw new PricingError(`Pricing entry ${key} has invalid ${fieldName}`);
    }
    return parsed;
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
