/**
 * ExecutionGatewayFactory - Assemble final runtime dependencies.
 *
 * Single Responsibility: Compose all factory outputs into final RunEngineDependencies.
 * Orchestrates LLM gateway, budgeting, agents, and session memory assembly.
 */

import type {
  RunEngineDependencies,
  AgentType,
  IAgent,
  LLMGateway,
} from "@shadowbox/execution-engine/runtime";
import type { Env } from "../../types/ai";
import { buildLLMGateway } from "./LLMRuntimeFactory";
import { buildPricingAndBudgeting } from "./BudgetingFactory";
import { resolveAgent } from "./AgentFactory";
import { buildSessionMemoryClient } from "./SessionMemoryFactory";
import type { ExecuteRunPayload } from "../parsing/ExecuteRunPayloadSchema";
import { WorkspaceBootstrapService } from "../services/WorkspaceBootstrapService";
import { getUserSessionByUserId } from "../../services/AuthService";

/**
 * Build complete runtime dependencies for RunEngine execution.
 *
 * Assembles:
 * - LLM gateway with AI service
 * - Cost tracking and budgeting
 * - Resolved agent
 * - Session memory client
 *
 * @param ctx - Durable Object state context
 * @param env - Cloudflare environment
 * @param payload - Execute run payload with parameters
 * @param options - Execution options (strict mode, etc.)
 * @returns { agent, runEngineDeps }
 */
export function buildRuntimeDependencies(
  ctx: unknown,
  env: Env,
  payload: ExecuteRunPayload,
  options: { strict?: boolean } = {},
): {
  agent: IAgent | undefined;
  runEngineDeps: RunEngineDependencies;
} {
  // Build pricing/budgeting first
  const budgetingComponents = buildPricingAndBudgeting(ctx, env);

  // Build LLM runtime with shared budgeting components
  const { llmRuntimeService, llmGateway } = buildLLMGateway(
    env,
    {
      runId: payload.runId,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
    },
    payload.input.providerId,
    budgetingComponents,
  );

  // Destructure pricing/budgeting components for return object
  const {
    pricingRegistry,
    costLedger,
    costTracker,
    budgetManager,
    pricingResolver,
  } = budgetingComponents;

  // Resolve agent with strict policy
  const agent = resolveAgent(
    env,
    llmGateway,
    payload.sessionId,
    payload.runId,
    payload.userId,
    payload.input.agentType,
    {
      strict: options.strict ?? true,
      correlationId: payload.correlationId,
    },
  );

  // Build session memory client
  const sessionMemoryClient = buildSessionMemoryClient(env, payload.sessionId);
  const workspaceBootstrapper = WorkspaceBootstrapService.fromEnv(
    env,
    payload.sessionId,
    payload.runId,
    payload.userId,
  );

  return {
    agent,
    runEngineDeps: {
      aiService: llmRuntimeService,
      llmGateway,
      costLedger,
      costTracker,
      pricingRegistry,
      pricingResolver,
      budgetManager,
      sessionMemoryClient,
      workspaceBootstrapper,
      hasGitHubAuth: async ({ userId }) =>
        hasGitHubTokenForUser(env, userId ?? payload.userId),
    },
  };
}

async function hasGitHubTokenForUser(
  env: Env,
  userId: string | undefined,
): Promise<boolean> {
  if (!userId) {
    return false;
  }

  try {
    const session = await getUserSessionByUserId(env, userId);
    return hasEncryptedTokenShape(session?.encryptedToken);
  } catch (error) {
    console.warn(
      `[runtime/deps] Failed to resolve GitHub auth availability: ${String(error)}`,
    );
    return false;
  }
}

function hasEncryptedTokenShape(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as { ciphertext?: unknown; iv?: unknown };
  return (
    typeof record.ciphertext === "string" &&
    record.ciphertext.length > 0 &&
    typeof record.iv === "string" &&
    record.iv.length > 0
  );
}
