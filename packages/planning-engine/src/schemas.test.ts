/**
 * Zod Schema Tests
 *
 * Validates roundtrip safety and constraints for all schemas.
 * Ensures Type → JSON → Type is always valid.
 */

import { describe, it, expect } from 'vitest';
import {
  PlanSchema,
  PlanStepSchema,
  ConstraintSchema,
  PlanningOutputSchema,
  validatePlan,
  safeParsePlan,
} from './schemas.js';
import type { Plan, PlanStep, Constraint } from './types.js';

describe('Schema Validation', () => {
  describe('PlanStepSchema', () => {
    it('accepts valid plan step', () => {
      const step: PlanStep = {
        id: 'step_1',
        description: 'Read the repository structure',
        action: 'read_files',
        tools: ['read_file', 'list_files'],
        dependsOn: [],
        canParallelizeWith: ['step_2'],
        stopCondition: 'When all files have been read',
        estimatedTokens: 500,
        requiresApproval: false,
        priority: 5,
      };

      expect(() => PlanStepSchema.parse(step)).not.toThrow();
    });

    it('rejects step with invalid id format', () => {
      const step = {
        id: 'invalid_id',
        description: 'Read the repository structure',
        action: 'read_files',
        tools: ['read_file'],
        dependsOn: [],
        canParallelizeWith: [],
        stopCondition: 'When done',
        estimatedTokens: 500,
        requiresApproval: false,
        priority: 5,
      };

      expect(() => PlanStepSchema.parse(step)).toThrow();
    });

    it('rejects step with no tools', () => {
      const step = {
        id: 'step_1',
        description: 'Do something',
        action: 'read_files',
        tools: [],
        dependsOn: [],
        canParallelizeWith: [],
        stopCondition: 'When done',
        estimatedTokens: 500,
        requiresApproval: false,
        priority: 5,
      };

      expect(() => PlanStepSchema.parse(step)).toThrow();
    });

    it('rejects step with too few estimated tokens', () => {
      const step = {
        id: 'step_1',
        description: 'Do something',
        action: 'read_files',
        tools: ['read_file'],
        dependsOn: [],
        canParallelizeWith: [],
        stopCondition: 'When done',
        estimatedTokens: 5, // Too low
        requiresApproval: false,
        priority: 5,
      };

      expect(() => PlanStepSchema.parse(step)).toThrow();
    });

    it('accepts step with optional fields undefined', () => {
      const step = {
        id: 'step_1',
        description: 'Read the repository structure',
        action: 'read_files',
        tools: ['read_file'],
        dependsOn: [],
        canParallelizeWith: [],
        stopCondition: 'When done',
        estimatedTokens: 500,
        requiresApproval: false,
        priority: 5,
        expectedInput: undefined,
        expectedOutput: undefined,
      };

      expect(() => PlanStepSchema.parse(step)).not.toThrow();
    });
  });

  describe('ConstraintSchema', () => {
    it('accepts valid constraint', () => {
      const constraint: Constraint = {
        type: 'token_budget',
        description: 'Plan exceeds available token budget',
        severity: 'error',
        mitigation: 'Split plan into smaller steps',
        blocksExecution: true,
      };

      expect(() => ConstraintSchema.parse(constraint)).not.toThrow();
    });

    it('rejects constraint with invalid severity', () => {
      const constraint = {
        type: 'token_budget',
        description: 'Plan exceeds budget',
        severity: 'invalid',
        blocksExecution: true,
      };

      expect(() => ConstraintSchema.parse(constraint)).toThrow();
    });

    it('accepts constraint without mitigation', () => {
      const constraint = {
        type: 'scope',
        description: 'Plan scope is ambiguous',
        severity: 'warning',
        blocksExecution: false,
      };

      expect(() => ConstraintSchema.parse(constraint)).not.toThrow();
    });
  });

  describe('PlanSchema (roundtrip)', () => {
    it('validates a complete plan', () => {
      const plan: Plan = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        strategy: 'implement',
        steps: [
          {
            id: 'step_1',
            description: 'Analyze the requirements',
            action: 'analyze',
            tools: ['read_file'],
            dependsOn: [],
            canParallelizeWith: [],
            stopCondition: 'Requirements understood',
            estimatedTokens: 500,
            requiresApproval: false,
            priority: 5,
          },
          {
            id: 'step_2',
            description: 'Write the implementation',
            action: 'write_code',
            tools: ['write_file'],
            dependsOn: ['step_1'],
            canParallelizeWith: [],
            stopCondition: 'Code written and saved',
            estimatedTokens: 1500,
            requiresApproval: true,
            priority: 8,
          },
        ],
        objective: 'Implement new feature X',
        complexity: 5,
        estimatedTokens: 2000,
        constraints: [
          {
            type: 'scope',
            description: 'Feature scope is well-defined',
            severity: 'info',
            blocksExecution: false,
          },
        ],
        metadata: {
          intent: 'implement',
          createdAt: 1707561600000,
          runId: 'run_550e8400e29b41d4a716446655440001',
          contextBlocksUsed: ['block_1'],
          plannerVersion: '1.0.0',
          isAlternative: false,
        },
      };

      expect(() => PlanSchema.parse(plan)).not.toThrow();
    });

    it('roundtrips: parse → JSON → parse', () => {
      const plan: Plan = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        strategy: 'bugfix',
        steps: [
          {
            id: 'step_1',
            description: 'Locate bug',
            action: 'read_files',
            tools: ['search_code'],
            dependsOn: [],
            canParallelizeWith: [],
            stopCondition: 'Bug found',
            estimatedTokens: 300,
            requiresApproval: false,
            priority: 9,
          },
        ],
        objective: 'Fix crash in module X',
        complexity: 3,
        estimatedTokens: 300,
        constraints: [],
        metadata: {
          intent: 'bugfix',
          createdAt: 1707561600000,
          runId: 'run_550e8400e29b41d4a716446655440001',
          contextBlocksUsed: [],
          plannerVersion: '1.0.0',
          isAlternative: false,
        },
      };

      const json = JSON.stringify(plan);
      const parsed = JSON.parse(json);
      expect(() => validatePlan(parsed)).not.toThrow();
    });

    it('rejects plan with empty steps array', () => {
      const plan = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        strategy: 'explore',
        steps: [],
        objective: 'Explore repo',
        complexity: 1,
        estimatedTokens: 100,
        constraints: [],
        metadata: {
          intent: 'explore',
          createdAt: 1707561600000,
          runId: 'run_550e8400e29b41d4a716446655440001',
          contextBlocksUsed: [],
          plannerVersion: '1.0.0',
          isAlternative: false,
        },
      };

      expect(() => PlanSchema.parse(plan)).toThrow();
    });

    it('rejects plan with complexity outside 1-10 range', () => {
      const plan = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        strategy: 'explore',
        steps: [
          {
            id: 'step_1',
            description: 'Do something',
            action: 'read_files',
            tools: ['read_file'],
            dependsOn: [],
            canParallelizeWith: [],
            stopCondition: 'Done',
            estimatedTokens: 100,
            requiresApproval: false,
            priority: 5,
          },
        ],
        objective: 'Explore',
        complexity: 15, // Outside range
        estimatedTokens: 100,
        constraints: [],
        metadata: {
          intent: 'explore',
          createdAt: 1707561600000,
          runId: 'run_550e8400e29b41d4a716446655440001',
          contextBlocksUsed: [],
          plannerVersion: '1.0.0',
          isAlternative: false,
        },
      };

      expect(() => PlanSchema.parse(plan)).toThrow();
    });
  });

  describe('validatePlan / safeParsePlan', () => {
    it('validatePlan throws on invalid data', () => {
      expect(() => validatePlan({ invalid: 'data' })).toThrow();
    });

    it('safeParsePlan returns error without throwing', () => {
      const result = safeParsePlan({ invalid: 'data' });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('safeParsePlan returns data on valid input', () => {
      const plan: Plan = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        strategy: 'explore',
        steps: [
          {
            id: 'step_1',
            description: 'Explore repo',
            action: 'read_files',
            tools: ['list_files'],
            dependsOn: [],
            canParallelizeWith: [],
            stopCondition: 'Done exploring',
            estimatedTokens: 200,
            requiresApproval: false,
            priority: 5,
          },
        ],
        objective: 'Get to know the repo',
        complexity: 1,
        estimatedTokens: 200,
        constraints: [],
        metadata: {
          intent: 'explore',
          createdAt: 1707561600000,
          runId: 'run_550e8400e29b41d4a716446655440001',
          contextBlocksUsed: [],
          plannerVersion: '1.0.0',
          isAlternative: false,
        },
      };

      const result = safeParsePlan(plan);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(plan);
    });
  });

  describe('PlanningOutputSchema', () => {
    it('accepts valid planning output', () => {
      const output = {
        plan: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          strategy: 'explore',
          steps: [
            {
              id: 'step_1',
              description: 'Explore repository',
              action: 'read_files',
              tools: ['list_files'],
              dependsOn: [],
              canParallelizeWith: [],
              stopCondition: 'All files explored',
              estimatedTokens: 200,
              requiresApproval: false,
              priority: 5,
            },
          ],
          objective: 'Explore repository structure',
          complexity: 1,
          estimatedTokens: 200,
          constraints: [],
          metadata: {
            intent: 'explore',
            createdAt: 1707561600000,
            runId: 'run_550e8400e29b41d4a716446655440001',
            contextBlocksUsed: [],
            plannerVersion: '1.0.0',
            isAlternative: false,
          },
        },
        confidence: 0.85,
        reasoning: 'This plan is straightforward exploration of the repository structure',
      };

      expect(() => PlanningOutputSchema.parse(output)).not.toThrow();
    });

    it('rejects output with confidence outside 0-1 range', () => {
      const output = {
        plan: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          strategy: 'explore',
          steps: [
            {
              id: 'step_1',
              description: 'Explore',
              action: 'read_files',
              tools: ['list_files'],
              dependsOn: [],
              canParallelizeWith: [],
              stopCondition: 'Done',
              estimatedTokens: 200,
              requiresApproval: false,
              priority: 5,
            },
          ],
          objective: 'Explore',
          complexity: 1,
          estimatedTokens: 200,
          constraints: [],
          metadata: {
            intent: 'explore',
            createdAt: 1707561600000,
            runId: 'run_550e8400e29b41d4a716446655440001',
            contextBlocksUsed: [],
            plannerVersion: '1.0.0',
            isAlternative: false,
          },
        },
        confidence: 1.5, // Invalid
        reasoning: 'Test',
      };

      expect(() => PlanningOutputSchema.parse(output)).toThrow();
    });
  });
});
