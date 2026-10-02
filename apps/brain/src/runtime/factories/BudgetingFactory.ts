/**
 * BudgetingFactory - Build pricing and budgeting components.
 *
 * Single Responsibility: Create pricing registry, cost tracking, and budget management.
 * Encapsulates cost accounting and budget enforcement setup.
 */

import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "../../types/ai";
import type {
  PricingRegistry,
  CostLedger,
  CostTracker,
  BudgetManager,
  PricingResolver,
} from "@legioncode/execution-engine/runtime";
import {
  PricingRegistry as PricingRegistryImpl,
  CostLedger as CostLedgerImpl,
  CostTracker as CostTrackerImpl,
  BudgetManager as BudgetManagerImpl,
  PricingResolver as PricingResolverImpl,
} from "@legioncode/execution-engine/runtime";

/**
 * Build pricing and budgeting components.
 *
 * @param ctx - Durable Object state context
 * @param env - Cloudflare environment
 * @returns { pricingRegistry, costLedger, costTracker, budgetManager, pricingResolver }
 */
export function buildPricingAndBudgeting(
  ctx: unknown,
  env: Env,
): {
  pricingRegistry: PricingRegistry;
  costLedger: CostLedger;
  costTracker: CostTracker;
  budgetManager: BudgetManager;
  pricingResolver: PricingResolver;
} {
  const pricingRegistry = new PricingRegistryImpl(undefined, {
    failOnUnseededPricing: env.COST_FAIL_ON_UNSEEDED_PRICING === "true",
  });

  const costLedger = new CostLedgerImpl(
    ctx as unknown as LegacyDurableObjectState,
  );

  const costTracker = new CostTrackerImpl(
    ctx as unknown as LegacyDurableObjectState,
    pricingRegistry,
    getUnknownPricingMode(env),
  );

  const budgetManager = new BudgetManagerImpl(
    costTracker,
    pricingRegistry,
    getBudgetConfig(env),
    ctx as unknown as LegacyDurableObjectState,
  );

  const pricingResolver = new PricingResolverImpl(pricingRegistry, {
    unknownPricingMode: getUnknownPricingMode(env),
  });

  return {
    pricingRegistry,
    costLedger,
    costTracker,
    budgetManager,
    pricingResolver,
  };
}

/**
 * Get unknown pricing mode from environment.
 * Defaults to "warn" if not configured or invalid.
 */
function getUnknownPricingMode(env: Env): "warn" | "block" {
  const mode = env.COST_UNKNOWN_PRICING_MODE;
  if (mode === "block" || mode === "warn") {
    return mode;
  }
  return "warn";
}

/**
 * Parse budget configuration from environment.
 */
function getBudgetConfig(env: Env): {
  maxCostPerRun?: number;
  maxCostPerSession?: number;
} {
  const parseBudget = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    // Use Number() constructor instead of parseFloat() to properly reject invalid strings
    // parseFloat("18aud") returns 18, but Number("18aud") returns NaN
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      console.warn(`[runtime/budgeting-factory] Invalid budget value: ${value}`);
      return undefined;
    }
    return parsed;
  };

  return {
    maxCostPerRun: parseBudget(env.MAX_RUN_BUDGET),
    maxCostPerSession: parseBudget(env.MAX_SESSION_BUDGET),
  };
}
