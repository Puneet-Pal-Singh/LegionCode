# Planning Engine

Structured planning engine for deterministic task orchestration in LegionCode.

## What It Does

The Planning Engine takes user intent + context and produces a **Plan artifact** — a deterministic, structured representation of what the system intends to do before any tool execution.

```
User Message + Context
         ↓
[PlanningEngine]
         ↓
   Plan Artifact
(steps, tools, dependencies)
```

This is Phase 2, Task 1 of the LegionCode roadmap.

## Core Concepts

### Plan

A **Plan** is an executable blueprint:
- Ordered **steps** with clear actions
- **Tool assignments** for each step
- **Dependencies** (which steps must complete first)
- **Stop conditions** (when each step is done)
- **Estimated tokens** (cost prediction)
- **Constraints** (risks or limitations identified)

Plans are deterministic — same input always produces same plan ID and structure.

### Planning Strategy

The engine selects a strategy based on user intent:

| Strategy | Use Case | Example |
|----------|----------|---------|
| `explore` | Read-only repo analysis | "What's in this repo?" |
| `bugfix` | Targeted bug fix | "Fix the crash in module X" |
| `refactor` | Code restructuring | "Refactor this class to be smaller" |
| `implement` | New feature | "Add user authentication" |
| `review` | Code review/analysis | "Review this PR" |
| `test` | Test writing | "Add tests for this function" |
| `optimize` | Performance/quality | "Make this 10x faster" |
| `unknown` | Fallback | Unknown intent |

### Constraints

The engine identifies risks:

```typescript
{
  type: 'token_budget' | 'complexity' | 'scope' | 'dependency' | ...
  severity: 'info' | 'warning' | 'error'
  blocksExecution: boolean
  mitigation?: string
}
```

## Architecture

```
PlanningEngine (orchestrator)
  ├── StrategyPlanner → select strategy based on intent
  ├── StepGenerator → create ordered steps
  ├── ConstraintAnalyzer → identify risks
  └── PlanValidator → check for errors (cycles, etc.)
```

## Usage Example

```typescript
import { PlanningEngine } from '@legioncode/planning-engine';
import type { PlanningInput } from '@legioncode/planning-engine';

const engine = new PlanningEngine();

const input: PlanningInput = {
  intent: {
    primary: 'implement',
    confidence: 0.95,
  },
  context: {
    // From ContextBuilder (Phase 1)
    systemPrompt: '...',
    userPrompt: '...',
    // ...
  },
  chatHistory: [...],
};

const { plan, confidence } = await engine.plan(input);

// Plan is now ready for execution
console.log(plan.steps); // [step_1, step_2, ...]
console.log(plan.estimatedTokens); // 2500
console.log(confidence); // 0.87
```

## Type Safety

All types are strict, with no `any` types:

```typescript
import type {
  Plan,
  PlanStep,
  Constraint,
  PlanningStrategy,
} from '@legioncode/planning-engine';

// Zod schemas for validation
import {
  validatePlan,
  safeParsePlan,
  PlanSchema,
} from '@legioncode/planning-engine';

// Validate JSON from storage/API
const plan = validatePlan(jsonData); // Throws if invalid
const result = safeParsePlan(jsonData); // Returns { success, data, error }
```

## Integration with Brain

The PlanningEngine integrates into Brain's ChatController:

```typescript
// In apps/brain/src/controllers/ChatController.ts

// Phase 1: Build context
const context = await contextBuilder.build({ ... });

// Phase 2 Task 1: Plan before executing
const { plan, confidence } = await planningEngine.plan({
  intent: context.metadata.intent,
  context,
});

// Store plan durably
await storage.put(`plan:${runId}`, plan);

// Emit to UI
await emitEvent('plan_ready', { plan, confidence });

// Execute (with optional user approval)
if (confidence > 0.7 && autoApprovalEnabled) {
  await executeWithPlan(plan);
}
```

## Determinism Guarantees

1. **Same input → Same plan ID**: Hashing of (intent, context, constraints)
2. **No randomness**: All logic is deterministic heuristics
3. **No LLM in planning step**: LLM calls only in execution
4. **Roundtrip safe**: Plan → JSON → Plan always valid

## Testing

```bash
# Run tests
npm run test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

## Project Structure

```
src/
├── types.ts              # Core type definitions
├── schemas.ts            # Zod validators
├── errors/
│   └── index.ts          # Custom error types
├── services/
│   ├── StrategyPlanner.ts
│   ├── StepGenerator.ts
│   ├── ConstraintAnalyzer.ts
│   └── PlanValidator.ts
├── PlanningEngine.ts     # Main orchestrator
└── index.ts              # Public API
```

## Next Steps (Phase 2 Implementation)

- [ ] Subtask B: StrategyPlanner service
- [ ] Subtask C: StepGenerator service
- [ ] Subtask D: ConstraintAnalyzer service
- [ ] Subtask E: PlanValidator service
- [ ] Subtask F: PlanningEngine orchestrator
- [ ] Subtask G: Brain integration
- [ ] Subtask H: UI integration
- [ ] Subtask I: Full test suite

## References

- **Roadmap**: `tasks/High_level_plan.md` (Phase 2)
- **Implementation Plan**: `tasks/PHASE_2_TASK_1_IMPL_PLAN.md`
- **Context Builder (Phase 1)**: `packages/context-builder/`
- **AGENTS.md**: Project guidelines and standards
