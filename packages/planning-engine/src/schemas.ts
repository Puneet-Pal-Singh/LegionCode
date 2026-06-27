/**
 * Planning Engine Zod Schemas
 *
 * Strict validation schemas for all planning engine types.
 * Ensures roundtrip safety: Type → JSON → Type.
 *
 * Pattern: Use strict refinements, discriminated unions.
 */

import { z } from 'zod';
import type {
  Plan,
  PlanStep,
  Constraint,
  PlanMetadata,
  PlanningInput,
  PlanningOutput,
  ExecutionResult,
  PlanValidationResult,
} from './types.js';

const RUN_ID_PATTERN = /^run_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/;

// ============================================================================
// Base Schemas
// ============================================================================

/**
 * UUID v4 string
 */
export const UUIDSchema = z.string().uuid().brand<'UUID'>();

/**
 * Planning strategy enum
 */
export const PlanningStrategySchema = z.enum([
  'explore',
  'bugfix',
  'refactor',
  'implement',
  'review',
  'test',
  'optimize',
  'unknown',
]);

/**
 * Step action enum
 */
export const StepActionSchema = z.enum([
  'read_files',
  'analyze',
  'write_code',
  'run_tools',
  'git_operation',
  'query_llm',
  'summarize',
  'review',
]);

/**
 * Constraint type enum
 */
export const ConstraintTypeSchema = z.enum([
  'scope',
  'complexity',
  'token_budget',
  'dependency',
  'risk',
  'resource',
  'approval',
]);

/**
 * Severity level enum
 */
export const SeveritySchema = z.enum(['info', 'warning', 'error']);

// ============================================================================
// Constraint Schema
// ============================================================================

export const ConstraintSchema = z
  .object({
    type: ConstraintTypeSchema,
    description: z.string().min(1).max(500),
    severity: SeveritySchema,
    mitigation: z.string().max(500).optional(),
    blocksExecution: z.boolean(),
  })
  .strict() as z.ZodType<Constraint>;

// ============================================================================
// Plan Step Schema
// ============================================================================

export const PlanStepSchema = z
  .object({
    id: z.string().regex(/^step_\d+$/, 'Step ID must be "step_N" format'),
    description: z.string().min(5).max(500),
    action: StepActionSchema,
    tools: z.array(z.string().min(1)).min(1, 'At least one tool required'),
    expectedInput: z.record(z.unknown()).optional(),
    expectedOutput: z.string().max(500).optional(),
    dependsOn: z.array(z.string()).refine((deps) => deps.length <= 5, {
      message: 'Step should depend on at most 5 other steps',
    }),
    canParallelizeWith: z.array(z.string()),
    stopCondition: z.string().min(5).max(300),
    estimatedTokens: z
      .number()
      .int()
      .min(10, 'Estimated tokens must be >= 10')
      .max(10000, 'Estimated tokens must be <= 10000'),
    requiresApproval: z.boolean(),
    priority: z.number().int().min(0).max(10),
  })
  .strict() as z.ZodType<PlanStep>;

// ============================================================================
// Plan Metadata Schema
// ============================================================================

export const PlanMetadataSchema = z
  .object({
    intent: z.string().min(1).max(100),
    createdAt: z.number().int().min(0),
    runId: z.string().regex(RUN_ID_PATTERN),
    contextBlocksUsed: z.array(z.string()),
    plannerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    isAlternative: z.boolean(),
  })
  .strict() as z.ZodType<PlanMetadata>;

// ============================================================================
// Plan Schema (Core Artifact)
// ============================================================================

export const PlanSchema = z
  .object({
    id: z.string().uuid(),
    strategy: PlanningStrategySchema,
    steps: z.array(PlanStepSchema).min(1, 'Plan must have at least one step'),
    objective: z.string().min(10).max(500),
    complexity: z.number().int().min(1).max(10),
    estimatedTokens: z
      .number()
      .int()
      .min(100, 'Estimated tokens must be >= 100')
      .max(100000, 'Estimated tokens must be <= 100000'),
    constraints: z.array(ConstraintSchema),
    metadata: PlanMetadataSchema,
  })
  .strict()
  .refine((plan) => plan.estimatedTokens >= plan.steps.length * 10, {
    message: 'Total estimated tokens must be sum of all step tokens',
    path: ['estimatedTokens'],
  }) as z.ZodType<Plan>;

// ============================================================================
// Planning Input/Output Schemas
// ============================================================================

export const PlanningOutputSchema = z
  .object({
    plan: PlanSchema,
    confidence: z.number().min(0).max(1),
    alternatives: z.array(PlanSchema).optional(),
    reasoning: z.string().min(10).max(2000),
  })
  .strict() as z.ZodType<PlanningOutput>;

// ============================================================================
// Execution Result Schema
// ============================================================================

export const ExecutionResultSchema = z
  .object({
    planId: z.string().uuid(),
    failedStep: z.string().optional(),
    status: z.enum(['success', 'partial', 'failed']),
    durationMs: z.number().int().min(0),
    executedSteps: z.array(z.string()),
    actualTokensUsed: z.number().int().min(0),
    tokenEstimateDelta: z.number().int(),
    error: z.string().optional(),
    feedback: z.string().optional(),
  })
  .strict() as z.ZodType<ExecutionResult>;

// ============================================================================
// Validation Result Schemas
// ============================================================================

export const ValidationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  location: z.string().optional(),
});

export const ValidationWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  suggestion: z.string().optional(),
});

export const PlanValidationResultSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(ValidationIssueSchema),
    warnings: z.array(ValidationWarningSchema),
  })
  .strict() as z.ZodType<PlanValidationResult>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate a plan object
 * Throws ZodError if invalid
 */
export function validatePlan(data: unknown): Plan {
  return PlanSchema.parse(data);
}

/**
 * Safe plan validation (returns error instead of throwing)
 */
export function safeParsePlan(data: unknown): { success: boolean; data?: Plan; error?: string } {
  const result = PlanSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; '),
  };
}

/**
 * Validate planning output
 */
export function validatePlanningOutput(data: unknown): PlanningOutput {
  return PlanningOutputSchema.parse(data);
}

/**
 * Validate execution result
 */
export function validateExecutionResult(data: unknown): ExecutionResult {
  return ExecutionResultSchema.parse(data);
}

/**
 * Validate validation result
 */
export function validateValidationResult(data: unknown): PlanValidationResult {
  return PlanValidationResultSchema.parse(data);
}
