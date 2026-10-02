# @legioncode/context-assembly

Vendor-neutral interfaces for context assembly in multi-agent systems.

## Overview

This package defines the contracts and type definitions for assembling LLM context from:

- Repository snapshots
- Memory stores
- Runtime events
- User goals

## Philosophy

**Task 0 = Interfaces Only**

This package contains:

- ✅ TypeScript interfaces
- ✅ Type definitions
- ✅ Contracts
- ✅ Documentation

This package does NOT contain:

- ❌ Implementations
- ❌ Runtime logic
- ❌ Algorithms
- ❌ Utilities

## Core Invariants

All implementations MUST respect:

1. **No Side Effects** - Context assembly must be pure
2. **No Network Calls** - No external dependencies during assembly
3. **No Filesystem Access** - All data via snapshots
4. **No Memory Mutation** - Immutable operations only
5. **Deterministic** - Same input always produces same output

## Key Interfaces

### ContextBuilder

```typescript
interface ContextBuilder {
  build(input: ContextBuildInput): Promise<ContextBundle>;
}
```

Single responsibility: Convert raw world state → LLM-ready context.

### ContextBuildInput

```typescript
interface ContextBuildInput {
  runId: string;
  goal: UserGoal;
  agent: AgentDescriptor;
  repo?: RepoSnapshot;
  memory?: MemorySnapshot;
  recentEvents?: RuntimeEvent[];
  constraints: ContextConstraints;
}
```

### ContextBundle

```typescript
interface ContextBundle {
  system: string;
  messages: ContextMessage[];
  tools: ToolDescriptor[];
  tokenEstimate: number;
  debug?: ContextDebugInfo;
}
```

## Usage

```typescript
import type {
  ContextBuilder,
  ContextBuildInput,
  ContextBundle,
} from "@legioncode/context-assembly";

// Your implementation
class MyContextBuilder implements ContextBuilder {
  async build(input: ContextBuildInput): Promise<ContextBundle> {
    // Implementation here
  }
}
```

## Directory Structure

```
src/
├── index.ts          # Public API
└── types/
    ├── index.ts      # Type exports
    ├── context.ts    # Core types
    ├── input.ts      # Input interfaces
    ├── output.ts     # Output interfaces
    ├── repo.ts       # Repository types
    ├── memory.ts     # Memory types
    ├── runtime.ts    # Event types
    ├── tools.ts      # Tool types
    └── builder.ts    # Builder interfaces
```

## Next Steps

After these interfaces are frozen:

- **Task 1**: ContextBuilder implementation
- **Task 2**: Token budgeting strategies
- **Task 3**: Source adapters
- **Task 4**: Advanced strategies

## License

MIT
