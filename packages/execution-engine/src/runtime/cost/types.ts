// packages/execution-engine/src/runtime/cost/types.ts
// Phase 3.1: Cost hardening canonical types

import type { LLMPhase } from "../llm/types.js";

export interface RuntimeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface RuntimeDurableObjectState {
  storage: RuntimeStorage;
  blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
}

/**
 * Standardized LLM usage metadata returned by provider adapters.
 */
export interface LLMUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  raw?: unknown;
}

export type PricingSource = "provider" | "litellm" | "registry" | "unknown";

/**
 * Canonical append-only event shape for ledger persistence.
 */
export interface CostEvent {
  eventId: string;
  idempotencyKey: string;
  runId: string;
  sessionId: string;
  taskId?: string;
  agentType: string;
  phase: LLMPhase;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerCostUsd?: number;
  calculatedCostUsd: number;
  pricingSource: PricingSource;
  createdAt: string;
}

export interface ModelCost {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface ProviderCost {
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/**
 * Aggregated view generated at read time from append-only events.
 */
export interface CostSnapshot {
  runId: string;
  totalCost: number;
  totalTokens: number;
  eventCount: number;
  byModel: Record<string, ModelCost>;
  byProvider: Record<string, ProviderCost>;
  timestamp: string;
}

export interface CalculatedCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  pricingSource: PricingSource;
}

export interface PricingEntry {
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  tiers?: PricingTierEntry[];
  currency: string;
  effectiveDate?: string;
  lastUpdated?: string;
  metadata?: {
    source?: string;
    version?: string;
  };
}

export interface PricingTierEntry {
  minimumContextTokens: number;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

export interface BudgetConfig {
  maxCostPerRun: number;
  maxCostPerSession: number;
  warningThreshold: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  currentCost: number;
  projectedCost: number;
  remainingBudget: number;
  sessionCost?: number;
  sessionRemainingBudget?: number;
  reason?: string;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxCostPerRun: 5.0,
  maxCostPerSession: 20.0,
  warningThreshold: 0.8,
};
