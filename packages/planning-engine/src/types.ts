/**
 * Planning Engine Types
 *
 * Core type definitions for the PlanningEngine service.
 * All types are strict, non-negotiable, and fully documented.
 *
 * Pattern: Discriminated unions for runtime safety, exhaustiveness checking.
 */

// Optional imports from Phase 1 packages (will be available at runtime)
// These are commented out for now to allow package to build independently
// import type { IntentClassification } from '@legioncode/intent-classifier';
// import type { ContextBuilderOutput } from '@legioncode/context-builder';

// Placeholder types (will be replaced with actual imports once Phase 1 is merged)
type IntentClassification = {
  primary: string;
  confidence?: number;
};

type ContextBuilderOutput = {
  systemPrompt: string;
  userPrompt: string;
  contextBlocks: Array<{
    id: string;
    type: string;
    content: string;
  }>;
  tokenReport: {
    totalUsed: number;
  };
  metadata: {
    intent: string;
  };
};

/**
 * Input to PlanningEngine.plan()
 */
export interface PlanningInput {
  /** Pre-classified intent from IntentClassifier */
  intent: IntentClassification;

  /** Bounded context from Phase 1 (ContextBuilder) */
  context: ContextBuilderOutput;

  /** Chat history for continuity (optional) */
  chatHistory?: ChatTurn[];

  /** Execution constraints that affect planning */
  constraints?: PlanningConstraints;
}

/**
 * A single turn in the chat history
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

/**
 * Planning constraints that affect strategy selection
 */
export interface PlanningConstraints {
  /** Maximum number of steps in the plan */
  maxSteps?: number;

  /** Maximum complexity score (0-10) */
  maxComplexity?: number;

  /** Force approval mode (no auto-execution) */
  forceApprovalMode?: boolean;

  /** Forbidden tools (cannot be used in this plan) */
  forbiddenTools?: string[];

  /** Required tools (must be included if feasible) */
  requiredTools?: string[];
}

/**
 * Output from PlanningEngine.plan()
 */
export interface PlanningOutput {
  /** The primary plan */
  plan: Plan;

  /** Confidence in this plan (0-1) */
  confidence: number;

  /** Alternative plans as fallbacks */
  alternatives?: Plan[];

  /** Reasoning for the plan structure */
  reasoning: string;
}

/**
 * The core Plan artifact
 *
 * A deterministic, structured representation of what the system intends to do
 * before any tool execution. Serves as a contract between "thinking" and "doing".
 */
export interface Plan {
  /** Unique identifier for this plan instance */
  id: string;

  /** Planning strategy that generated this plan */
  strategy: PlanningStrategy;

  /** Ordered steps to execute (must form acyclic DAG) */
  steps: PlanStep[];

  /** High-level objective or goal */
  objective: string;

  /** Complexity score (1-10, higher = more complex) */
  complexity: number;

  /** Estimated total tokens needed to execute this plan */
  estimatedTokens: number;

  /** Constraints or risks identified during planning */
  constraints: Constraint[];

  /** Metadata about the plan */
  metadata: PlanMetadata;
}

/**
 * Planning strategy determines how to break down the task
 */
export type PlanningStrategy =
  | 'explore' // Repo exploration, read-only analysis
  | 'bugfix' // Targeted bug fix, small scope
  | 'refactor' // Code restructuring, no behavior change
  | 'implement' // New feature or capability
  | 'review' // Code review or analysis
  | 'test' // Test writing or test-driven approach
  | 'optimize' // Performance or code quality improvement
  | 'unknown'; // Fallback for unrecognized intent

/**
 * A single executable step in the plan
 */
export interface PlanStep {
  /** Step identifier within plan (e.g., "step_1", "step_2") */
  id: string;

  /** Human-readable description of what this step does */
  description: string;

  /** Type of action this step performs */
  action: StepAction;

  /** Tools required to execute this step */
  tools: string[];

  /** Expected input data (what context is needed) */
  expectedInput?: Record<string, unknown>;

  /** Expected output (what this step produces) */
  expectedOutput?: string;

  /** Step IDs that must complete before this one (for ordering) */
  dependsOn: string[];

  /** Step IDs that can run in parallel with this one */
  canParallelizeWith: string[];

  /** Condition for determining when this step is complete */
  stopCondition: string;

  /** Estimated tokens for this step alone */
  estimatedTokens: number;

  /** Whether user approval is required before executing this step */
  requiresApproval: boolean;

  /** Priority hint for scheduling (0-10, higher = more urgent) */
  priority: number;
}

/**
 * Types of actions a step can perform
 */
export type StepAction =
  | 'read_files' // Read and analyze file contents
  | 'analyze' // Analysis without modification
  | 'write_code' // Create or modify code
  | 'run_tools' // Execute tools (tests, linters, git)
  | 'git_operation' // Git commit, branch, merge, etc.
  | 'query_llm' // Ask LLM for reasoning or suggestion
  | 'summarize' // Create artifact, summary, or report
  | 'review'; // Manual review point, wait for approval

/**
 * Constraint or risk identified during planning
 */
export interface Constraint {
  /** Category of constraint */
  type: ConstraintType;

  /** Human-readable description */
  description: string;

  /** Severity level */
  severity: 'info' | 'warning' | 'error';

  /** Suggested mitigation or workaround */
  mitigation?: string;

  /** Should this constraint block execution? */
  blocksExecution: boolean;
}

/**
 * Types of constraints that can be identified
 */
export type ConstraintType =
  | 'scope' // Plan scope is too large or ambiguous
  | 'complexity' // Plan is too complex
  | 'token_budget' // Plan exceeds token budget
  | 'dependency' // Dependency issues (circular, missing)
  | 'risk' // Risk or safety concern
  | 'resource' // Resource limitation (tool unavailable)
  | 'approval' // Requires special approval or mode;

/**
 * Metadata about the plan
 */
export interface PlanMetadata {
  /** Intent that triggered this plan */
  intent: string;

  /** Timestamp when plan was created (ms since epoch) */
  createdAt: number;

  /** Run ID this plan belongs to */
  runId: string;

  /** Context block IDs used to inform this plan */
  contextBlocksUsed: string[];

  /** Version of the planning engine that produced this */
  plannerVersion: string;

  /** Whether this is a fallback/alternative plan */
  isAlternative: boolean;
}

/**
 * Result of plan execution (stored after execution)
 */
export interface ExecutionResult {
  /** Which plan was executed */
  planId: string;

  /** Which step failed (if any) */
  failedStep?: string;

  /** Overall result status */
  status: 'success' | 'partial' | 'failed';

  /** Duration in ms */
  durationMs: number;

  /** Steps that actually executed */
  executedSteps: string[];

  /** Actual tokens consumed */
  actualTokensUsed: number;

  /** Difference from estimate (can be positive or negative) */
  tokenEstimateDelta: number;

  /** Error message if failed */
  error?: string;

  /** Useful for plan refinement */
  feedback?: string;
}

/**
 * Deterministic plan validation result
 */
export interface PlanValidationResult {
  /** Is the plan valid and executable? */
  valid: boolean;

  /** Validation errors (if any) */
  errors: ValidationIssue[];

  /** Warnings that don't block execution */
  warnings: ValidationWarning[];
}

/**
 * A validation error (blocks execution)
 */
export interface ValidationIssue {
  code: string;
  message: string;
  location?: string; // e.g., "step_2.dependsOn"
}

/**
 * A validation warning (doesn't block, but should be noticed)
 */
export interface ValidationWarning {
  code: string;
  message: string;
  suggestion?: string;
}
