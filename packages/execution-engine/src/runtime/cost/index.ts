// apps/brain/src/core/cost/index.ts
// Phase 3.1: Operational Cost Layer barrel exports

export {
  CostTracker,
  CostTrackingError,
  type ICostTracker,
} from "./CostTracker.js";
export { CostLedger, type ICostLedger } from "./CostLedger.js";

export {
  PricingRegistry,
  PricingError,
  registerRuntimeModelPricing,
  type IPricingRegistry,
  type PricingRegistryOptions,
} from "./PricingRegistry.js";
export {
  PricingResolver,
  type IPricingResolver,
  type PricingResolution,
  type PricingResolverOptions,
} from "./PricingResolver.js";

export {
  BudgetManager,
  BudgetExceededError,
  SessionBudgetExceededError,
  type BudgetPolicy,
  type IBudgetManager,
} from "./BudgetManager.js";

export type {
  LLMUsage,
  CalculatedCost,
  CostEvent,
  CostSnapshot,
  ModelCost,
  PricingSource,
  ProviderCost,
  PricingEntry,
  BudgetConfig,
  BudgetCheckResult,
} from "./types.js";

export { DEFAULT_BUDGET } from "./types.js";
