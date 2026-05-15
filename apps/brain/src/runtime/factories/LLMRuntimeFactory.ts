/**
 * LLMRuntimeFactory - Build LLM runtime dependencies.
 *
 * Single Responsibility: Create LLM gateway and related services.
 * Encapsulates provider validation, AI service setup, and LLM gateway construction.
 */

import type { Env } from "../../types/ai";
import { AIService } from "../../services/AIService";
import {
  ProviderConfigService,
  ProviderRegistryService,
} from "../../services/providers";
import { ProviderValidationService } from "../../services/ProviderValidationService";
import { readByokEncryptionKey } from "../../services/providers/provider-encryption-key";
import { createPostgresProviderConfigService } from "../../services/providers/stores/PostgresStoreFactory";
import type { ProviderStoreScopeInput } from "../../types/provider-scope";
import {
  logErrorRateLimited,
  logWarnRateLimited,
} from "../../lib/rate-limited-log";
import type {
  LLMRuntimeAIService,
  LLMGateway,
  PricingRegistry,
  PricingResolver,
  CostLedger,
  CostTracker,
  BudgetManager,
} from "@shadowbox/execution-engine/runtime";
import { LLMGateway as LLMGatewayImpl } from "@shadowbox/execution-engine/runtime";

/**
 * Build LLM gateway and AI service for runtime execution.
 *
 * Uses D1-backed stores for provider configuration.
 *
 * @param env - Cloudflare environment
 * @param providerScope - Scope for provider credential store keying
 * @param budgetingComponents - Pre-built pricing/budgeting components from BudgetingFactory
 * @returns { llmRuntimeService, llmGateway }
 * @throws Error if provider validation fails
 */
export function buildLLMGateway(
  env: Env,
  providerScope: ProviderStoreScopeInput,
  activeProviderId: string | undefined,
  budgetingComponents: {
    pricingRegistry: PricingRegistry;
    costLedger: CostLedger;
    costTracker: CostTracker;
    budgetManager: BudgetManager;
    pricingResolver: PricingResolver;
  },
): {
  llmRuntimeService: LLMRuntimeAIService;
  llmGateway: LLMGateway;
} {
  const userId = providerScope.userId;
  const workspaceId = providerScope.workspaceId;

  if (!userId || !workspaceId) {
    throw new Error(
      `Invalid provider scope: userId="${userId}", workspaceId="${workspaceId}". Both are required.`,
    );
  }

  const providerConfigService = createProviderConfigService(
    env,
    userId,
    workspaceId,
  );
  const providerRegistryService = new ProviderRegistryService();
  const aiService = new AIService(env, providerConfigService);

  const llmRuntimeService: LLMRuntimeAIService = {
    getProvider: () => aiService.getProvider(),
    getDefaultModel: () => aiService.getDefaultModel(),
    generateText: (input) => aiService.generateText(input),
    generateStructured: (input) => aiService.generateStructured(input),
    createChatStream: (input) => aiService.createChatStream(input),
  };

  const llmGateway = new LLMGatewayImpl({
    aiService: llmRuntimeService,
    budgetPolicy: budgetingComponents.budgetManager,
    costLedger: budgetingComponents.costLedger,
    pricingResolver: budgetingComponents.pricingResolver,
    providerCapabilityResolver: {
      getCapabilities: (providerId: string) =>
        providerRegistryService.getProviderCapabilities(providerId),
      isModelAllowed: (providerId: string, modelId: string) => {
        if (!providerRegistryService.isProviderRegistered(providerId)) {
          return false;
        }
        return modelId.trim().length > 0;
      },
      getExecutionProfile: (providerId: string, modelId: string) =>
        providerRegistryService.getExecutionProfile(providerId, modelId),
    },
  });

  return { llmRuntimeService, llmGateway };
}

function createProviderConfigService(
  env: Env,
  userId: string,
  workspaceId: string,
): ProviderConfigService {
  return createPostgresProviderConfigService(env, userId, workspaceId);
}
