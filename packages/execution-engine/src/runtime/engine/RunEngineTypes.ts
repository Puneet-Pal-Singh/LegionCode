import type { CoreMessage, CoreTool } from "ai";
import type { RunEvent } from "@repo/shared-types";
import type { PlannerService } from "../planner/index.js";
import type { TaskScheduler } from "../orchestration/index.js";
import type {
  BudgetPolicy,
  IBudgetManager,
  ICostLedger,
  ICostTracker,
  IPricingRegistry,
  IPricingResolver,
} from "../cost/index.js";
import type { RunInput, RunStatus, WorkspaceBootstrapper } from "../types.js";
import type { ILLMGateway, LLMRuntimeAIService } from "../llm/index.js";
import type {
  MemoryCoordinator,
  MemoryCoordinatorDependencies,
} from "../memory/index.js";

export interface IRunEngine {
  execute(
    input: RunInput,
    messages: CoreMessage[],
    tools: Record<string, CoreTool>,
  ): Promise<Response>;
  getRunStatus(runId: string): Promise<RunStatus | null>;
  cancel(runId: string): Promise<boolean>;
}

export interface RunEngineOptions {
  env: RunEngineEnv;
  sessionId: string;
  runId: string;
  userId?: string;
  correlationId: string;
  requestOrigin?: string;
}

export interface RunEngineEnv {
  COST_FAIL_ON_UNSEEDED_PRICING?: string;
  COST_UNKNOWN_PRICING_MODE?: string;
  MAX_RUN_BUDGET?: string;
  MAX_SESSION_BUDGET?: string;
  APPROVAL_WAIT_TIMEOUT_MS?: string;
  FEATURE_FLAG_FINAL_SUMMARY_CONTRACT_V1?: string;
  NODE_ENV?: string;
  ALLOW_DEFAULT_EXECUTOR?: string;
}

export type GitHubAuthAvailabilityChecker = (input: {
  userId?: string;
  runId: string;
  sessionId: string;
  runInput: RunInput;
}) => Promise<boolean> | boolean;

export interface RunEngineDependencies {
  aiService?: LLMRuntimeAIService;
  llmGateway?: ILLMGateway;
  costLedger?: ICostLedger;
  costTracker?: ICostTracker;
  pricingRegistry?: IPricingRegistry;
  pricingResolver?: IPricingResolver;
  budgetManager?: IBudgetManager & BudgetPolicy;
  planner?: PlannerService;
  scheduler?: TaskScheduler;
  memoryCoordinator?: MemoryCoordinator;
  sessionMemoryClient?: MemoryCoordinatorDependencies["sessionMemoryClient"];
  workspaceBootstrapper?: WorkspaceBootstrapper;
  hasGitHubAuth?: GitHubAuthAvailabilityChecker;
  prepareMutationCapture?: () => Promise<void>;
  runEventListener?: (event: RunEvent) => Promise<void> | void;
}
