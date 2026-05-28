import type {
  EffectivePermissionState,
  PermissionRuntimeLabel,
  ProviderModelTransport,
  RunMode,
  RunTerminalState,
  ToolActivityMetadata,
  WorkflowIntentResolverInput,
} from "@repo/shared-types";

export interface RuntimeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>>;
}

export interface RuntimeDurableObjectState {
  storage: RuntimeStorage;
  blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
}

export type {
  CanonicalRunLifecycleStep,
  RunStatus,
  OrchestratorBackend,
  WorkflowStep,
} from "@shadowbox/orchestrator-core";

import type {
  CanonicalRunLifecycleStep,
  OrchestratorBackend,
  RunStatus,
  WorkflowStep,
} from "@shadowbox/orchestrator-core";

export type RunPhase = WorkflowStep;

export type AgentType = "coding" | "review" | "ci" | (string & {});
export type RuntimeHarnessId = "cloudflare-sandbox" | "local-sandbox";
export type RuntimeExecutionBackend = "cloudflare_sandbox" | "e2b" | "daytona";
export type RuntimeHarnessMode = "platform_owned" | "delegated";
export type RuntimeAuthMode = "api_key" | "oauth";

export interface RepositoryContext {
  owner?: string;
  repo?: string;
  branch?: string;
  baseUrl?: string;
}

export type WorkspaceBootstrapStatus =
  | "ready"
  | "needs-auth"
  | "invalid-context"
  | "sync-failed";

export type WorkspaceBootstrapMode = "read_only" | "mutation" | "git_write";

export interface WorkspaceBootstrapRequest {
  runId: string;
  repositoryContext: RepositoryContext;
  mode: WorkspaceBootstrapMode;
}

export interface WorkspaceBootstrapResult {
  status: WorkspaceBootstrapStatus;
  message?: string;
  clonedDuringBootstrap?: boolean;
}

export interface RunWorkspaceBootstrapState {
  requested: boolean;
  ready: boolean;
  status: WorkspaceBootstrapStatus | "skipped";
  mode?: WorkspaceBootstrapMode;
  blocked: boolean;
  message?: string;
  expectedMiss: boolean;
  clonedDuringBootstrap?: boolean;
  recordedAt: string;
}

export type GitTaskLane =
  | "typed_git"
  | "shell_git"
  | "github_connector"
  | "github_cli"
  | "shell_gh";

export type GitTaskClassification =
  | "inspect_ci"
  | "inspect_pr"
  | "inspect_review"
  | "mutate_fix"
  | "mutate_publish";

export interface RunGitTaskStrategyState {
  classification: GitTaskClassification;
  preferredLane: GitTaskLane;
  fallbackLane?: GitTaskLane;
  rationale: string;
  recordedAt: string;
}

export interface WorkspaceBootstrapper {
  bootstrap(
    request: WorkspaceBootstrapRequest,
  ): Promise<WorkspaceBootstrapResult>;
}

export interface RunInput {
  mode?: RunMode;
  agentType: AgentType;
  prompt: string;
  sessionId: string;
  providerId?: string;
  modelId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
  harnessId?: RuntimeHarnessId;
  orchestratorBackend?: OrchestratorBackend;
  executionBackend?: RuntimeExecutionBackend;
  harnessMode?: RuntimeHarnessMode;
  authMode?: RuntimeAuthMode;
  metadata?: Record<string, unknown>;
  // Phase 4: Repository context for workspace-aware operations
  repositoryContext?: RepositoryContext;
}

export interface RunOutput {
  content: string;
  finalSummary?: string;
}

export interface RunPlanArtifactTask {
  id: string;
  type: string;
  description: string;
  dependsOn: string[];
  expectedOutput?: string;
  executionKind: "read" | "mutating";
}

export interface RunPlanHandoff {
  targetMode: "build";
  prompt: string;
  summary: string;
}

export interface RunPlanArtifact {
  id: string;
  createdAt: string;
  summary: string;
  estimatedSteps: number;
  reasoning?: string;
  tasks: RunPlanArtifactTask[];
  handoff: RunPlanHandoff;
}

export type AgenticLoopToolLifecycleStatus =
  | "requested"
  | "started"
  | "completed"
  | "failed";

export interface AgenticLoopToolLifecycleEvent {
  toolCallId: string;
  toolName: string;
  status: AgenticLoopToolLifecycleStatus;
  mutating: boolean;
  recordedAt: string;
  detail?: string;
  metadata?: ToolActivityMetadata;
}

export interface AgenticLoopTerminalLlmIssue {
  type: "unusable_response";
  providerId: string;
  modelId: string;
  anomalyCode: string;
  attempts: number;
  finishReason?: string;
  statusCode?: number;
}

/**
 * RunManifest - Immutable run configuration determined at creation.
 *
 * This manifest is frozen at run creation and enforced to remain immutable
 * throughout the run lifecycle. Mid-run changes to any field are invalid.
 *
 * Selection fields follow deterministic precedence:
 * 1. Explicit selection from run creation input
 * 2. Policy defaults in RunManifestPolicy
 *
 * Once set, backend cannot change. Mismatch errors fail fast with typed errors.
 */
export interface RunManifest {
  mode: RunMode;
  providerId: string | null;
  modelId: string | null;
  runtimeModelId: string | null;
  providerTransport: ProviderModelTransport | null;
  providerEndpoint: string | null;
  harness: RuntimeHarnessId;
  /** Orchestrator backend identifier - determines which executor handles this run. */
  orchestratorBackend: OrchestratorBackend;
  /** Execution backend identifier - determines sandbox provider for task execution. */
  executionBackend: RuntimeExecutionBackend;
  /** Harness loop ownership mode - exactly one owner per run. */
  harnessMode: RuntimeHarnessMode;
  /** Provider auth mode selected at run creation. */
  authMode: RuntimeAuthMode;
}

export interface RunMetadata {
  prompt: string;
  actorUserId?: string;
  workspaceBootstrap?: RunWorkspaceBootstrapState;
  gitTaskStrategy?: RunGitTaskStrategyState;
  permissionContext?: {
    state: EffectivePermissionState;
    label: PermissionRuntimeLabel;
    resolverInput: WorkflowIntentResolverInput;
    resolvedAt: string;
  };
  continuation?: RunContinuationState;
  manifest?: RunManifest;
  turnMode?: {
    mode: "chat" | "action";
    source: "heuristic" | "llm" | "recovered";
    rationale?: string;
    confidence?: number;
    recordedAt: string;
  };
  agenticLoop?: {
    enabled: boolean;
    stopReason?:
      | "max_steps_reached"
      | "budget_exceeded"
      | "llm_stop"
      | "tool_error"
      | "cancelled";
    stepsExecuted?: number;
    toolExecutionCount?: number;
    failedToolCount?: number;
    requiresMutation?: boolean;
    currentTurnIntent?: "read_only" | "mutation" | "mixed";
    completedMutatingToolCount?: number;
    completedReadOnlyToolCount?: number;
    recoveryCode?: "TASK_MODEL_NO_ACTION";
    llmRetryCount?: number;
    terminalLlmIssue?: AgenticLoopTerminalLlmIssue;
    toolLifecycle?: AgenticLoopToolLifecycleEvent[];
    completedAt?: string;
  };
  reviewerPass?: {
    enabled: boolean;
    verdict?: "accept" | "request_changes" | "fail";
    summary?: string;
    issues?: string[];
    reviewedAt?: string;
    applied: boolean;
    error?: string;
  };
  lifecycleSteps?: Array<{
    step: CanonicalRunLifecycleStep;
    recordedAt: string;
    detail?: string;
  }>;
  phaseSelectionSnapshots?: Partial<Record<RunPhase, RunManifest>>;
  orchestrationTelemetry?: RunOrchestrationTelemetry;
  planId?: string;
  planArtifact?: RunPlanArtifact;
  completedAt?: string;
  error?: string;
  startedAt?: string;
  terminalState?: RunTerminalState;
}

export interface RunOrchestrationTelemetry {
  activeDurationMs: number;
  wakeupCount: number;
  resumeCount: number;
  lastWakeupAt?: string;
  lastResumedAt?: string;
  lastTerminalAt?: string;
}

export interface RunContinuationState {
  previousPrompt: string;
  previousOutput?: string;
  previousStopReason?:
    | "max_steps_reached"
    | "budget_exceeded"
    | "llm_stop"
    | "tool_error"
    | "cancelled";
  completedFiles: string[];
  restorableEdits: Array<{
    filePath: string;
    content: string;
  }>;
  completedGitSteps: string[];
  hasTrustedGitCommitIdentity?: boolean;
  activeBranch?: string;
  failedToolName?: string;
  failedToolDetail?: string;
  failedCommand?: string;
  recordedAt: string;
}

export interface SerializedRun {
  id: string;
  sessionId: string;
  status: RunStatus;
  agentType: AgentType;
  input: RunInput;
  output?: RunOutput;
  metadata: RunMetadata;
  createdAt: string;
  updatedAt: string;
}

export type TaskType =
  | "analyze"
  | "edit"
  | "test"
  | "review"
  | "git"
  | "shell"
  | (string & {});

export type TaskStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "DONE"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "RETRYING";

export interface TaskInput {
  description: string;
  expectedOutput?: string;
  [key: string]: unknown;
}

export interface TaskOutput {
  content: string;
  artifacts?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskError {
  message: string;
  code?: string;
  stack?: string;
}

export interface SerializedTask {
  id: string;
  runId: string;
  type: TaskType;
  status: TaskStatus;
  dependencies: string[];
  input: TaskInput;
  output?: TaskOutput;
  error?: TaskError;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  output?: TaskOutput;
  error?: TaskError;
  completedAt: Date;
}

export interface AgentCapability {
  name: string;
  description: string;
}

export interface ExecutionContext {
  runId: string;
  sessionId: string;
  dependencies: TaskResult[];
  modelId?: string;
  providerId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
}

export interface SynthesisContext {
  runId: string;
  sessionId: string;
  completedTasks: SerializedTask[];
  originalPrompt: string;
  modelId?: string;
  providerId?: string;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
}

export interface RuntimeTask {
  id: string;
  runId: string;
  type: TaskType;
  input: TaskInput;
}

export interface RuntimeExecutionService {
  execute(
    plugin: string,
    action: string,
    payload: Record<string, unknown>,
    options?: {
      onOutput?: (chunk: ExecutionOutputChunk) => Promise<void> | void;
    },
  ): Promise<unknown>;
}

export interface ExecutionOutputChunk {
  message: string;
  source?: "stdout" | "stderr";
  timestamp?: number;
}

export interface IAgent {
  readonly type: string;
  plan(
    context: import("./planner/index.js").PlanContext,
  ): Promise<import("./planner/PlanSchema.js").Plan>;
  executeTask(
    task: RuntimeTask,
    context: ExecutionContext,
  ): Promise<TaskResult>;
  synthesize(context: SynthesisContext): Promise<string>;
  getCapabilities(): AgentCapability[];
}

export interface IAgentRegistry {
  register(agent: IAgent): void;
  get(type: string): IAgent;
  has(type: string): boolean;
  getAvailableTypes(): string[];
}
